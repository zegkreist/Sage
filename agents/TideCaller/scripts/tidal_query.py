#!/usr/bin/env python3
"""
tidal_query.py — Bridge JSON para o MusicSage API.

Comandos:
  python tidal_query.py search-artists QUERY        → JSON array de artistas
  python tidal_query.py list-albums    ARTIST_ID    → JSON array de álbuns
  python tidal_query.py album-info     ALBUM_ID     → JSON com metadados do álbum
  python tidal_query.py download-albums ALBUM_ID... → baixa e imprime status JSON

Saída sempre é JSON válido em stdout; erros como {"error": "..."} com exit 1.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR  = Path(__file__).parent.absolute()
AGENT_DIR   = SCRIPT_DIR.parent
CONFIG_TOML = AGENT_DIR / "config" / ".config" / "streamrip" / "config.toml"

# Qualidade alvo para Tidal: 3 = HiFi (FLAC) — requer plano HiFi ou superior
_TARGET_TIDAL_QUALITY = 3

AUDIO_EXTS = {".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"}


def _has_new_audio_file(download_dir: str, since: float) -> bool:
    """
    Verifica se algum arquivo de áudio foi criado/modificado em download_dir
    desde `since`. O rip pode retornar exit code 0 mesmo quando só baixou a
    capa/metadados e pulou todas as faixas (erro por faixa tratado como aviso,
    não como falha) — exit code sozinho não é confiável como sinal de sucesso.
    """
    root = Path(download_dir)
    if not root.exists():
        return False
    for p in root.rglob("*"):
        if p.suffix.lower() in AUDIO_EXTS and p.is_file():
            try:
                if p.stat().st_mtime >= since:
                    return True
            except OSError:
                continue
    return False


def _patch_config_quality():
    """
    Garante que o config.toml do streamrip tem quality=3 para Tidal.
    NÃO altera o campo version — deixar o rip gerenciar isso normalmente.
    """
    if not CONFIG_TOML.exists():
        return
    try:
        text = CONFIG_TOML.read_text(encoding="utf-8")
        original = text

        # Forçar qualidade=1 na seção [tidal] apenas
        def set_tidal_quality(m):
            return re.sub(r'(?m)^(quality\s*=\s*)\d+', rf'\g<1>{_TARGET_TIDAL_QUALITY}', m.group(0), count=1)
        text = re.sub(r'(?ms)^\[tidal\].*?(?=^\[|\Z)', set_tidal_quality, text)

        if text != original:
            CONFIG_TOML.write_text(text, encoding="utf-8")
    except Exception:
        pass  # Não bloquear o download por falha de patch


def _patch_config_download_folder(download_dir: str):
    """
    Garante que o config.toml do streamrip aponta para a pasta de download
    desejada (TIDECALLER_DOWNLOADS). Necessário porque o rip v2.x não aceita
    mais --directory via CLI — a pasta só é lida do config.toml, então sem
    isso o download vai sempre para o "folder" gravado no arquivo (o padrão
    do template), não para a pasta que o MusicSage espera.
    """
    if not CONFIG_TOML.exists():
        return
    try:
        text = CONFIG_TOML.read_text(encoding="utf-8")
        original = text

        def set_folder(m):
            return re.sub(r'(?m)^(folder\s*=\s*).*$', rf'\g<1>"{download_dir}"', m.group(0), count=1)
        text = re.sub(r'(?ms)^\[downloads\].*?(?=^\[|\Z)', set_folder, text)

        if text != original:
            CONFIG_TOML.write_text(text, encoding="utf-8")
    except Exception:
        pass  # Não bloquear o download por falha de patch


def _patch_config_databases():
    """
    Desativa os bancos de estado do streamrip (downloads.db/failed_downloads.db).
    downloads.db pulava faixas registradas como baixadas mesmo com o arquivo
    movido depois; failed_downloads.db pulava para sempre faixas que falharam
    uma vez (token expirado, 429). Melhor re-baixar do que ficar sem faixa.
    Necessário em runtime porque o setup.sh só gera o config se ele não existir.
    """
    if not CONFIG_TOML.exists():
        return
    try:
        text = CONFIG_TOML.read_text(encoding="utf-8")
        original = text
        text = re.sub(r'(?m)^(downloads_enabled\s*=\s*)true', r'\g<1>false', text)
        text = re.sub(r'(?m)^(failed_downloads_enabled\s*=\s*)true', r'\g<1>false', text)
        if text != original:
            CONFIG_TOML.write_text(text, encoding="utf-8")
    except Exception:
        pass  # Não bloquear o download por falha de patch


def _save_refreshed_tokens(content, old_access, old_refresh, old_expiry, session) -> None:
    """
    Persiste no config.toml qualquer access_token/refresh_token/expiry que o
    tidalapi tenha atualizado na sessão (refresh automático acontece só em
    memória — se não gravarmos de volta, o refresh se perde ao processo
    terminar e o próximo check já falha com o token antigo).
    """
    new_access  = getattr(session, "access_token",  None) or old_access
    new_refresh = getattr(session, "refresh_token", None) or old_refresh
    new_expiry  = getattr(session, "expiry_time", None)
    expiry_ts = str(int(new_expiry.timestamp())) if new_expiry else old_expiry

    updated = content
    updated = re.sub(r'(?m)^(access_token\s*=\s*).*$',
                     f'access_token = "{new_access}"', updated)
    updated = re.sub(r'(?m)^(refresh_token\s*=\s*).*$',
                     f'refresh_token = "{new_refresh}"', updated)
    updated = re.sub(r'(?m)^(token_expiry\s*=\s*).*$',
                     f'token_expiry = "{expiry_ts}"', updated)
    if updated != content:
        CONFIG_TOML.write_text(updated, encoding="utf-8")


def _refresh_and_save_tokens():
    """
    Carrega sessão tidalapi, deixa o refresh automático acontecer se necessário,
    e sobrescreve access_token/refresh_token/token_expiry no config.toml com os
    valores atualizados.
    Retorna a sessão válida, ou None em caso de falha.
    """
    if not CONFIG_TOML.exists():
        return None
    try:
        import tidalapi
        from datetime import datetime, timezone

        content = CONFIG_TOML.read_text(encoding="utf-8")

        def _ex(key):
            m = re.search(rf'^{re.escape(key)}\s*=\s*"?([^"\n\s]+)"?', content, re.MULTILINE)
            return m.group(1) if m else ""

        access_token  = _ex("access_token")
        refresh_token = _ex("refresh_token")
        token_expiry  = _ex("token_expiry")

        if not refresh_token:
            return None

        session = tidalapi.Session()
        expiry_dt = datetime.fromtimestamp(int(float(token_expiry or 0)), tz=timezone.utc) if token_expiry else None
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)

        if not session.check_login():
            return None

        _save_refreshed_tokens(content, access_token, refresh_token, token_expiry, session)
        return session
    except Exception as e:
        sys.stderr.write(f"[WARN] _refresh_and_save_tokens: {e}\n")
        return None


# ── Sessão ────────────────────────────────────────────────────────────────────

def get_session():
    try:
        import tidalapi
    except ImportError:
        _err("tidalapi não instalado. Execute o setup do TideCaller.")

    content = CONFIG_TOML.read_text(encoding="utf-8") if CONFIG_TOML.exists() else ""

    # Tolera valor com ou sem aspas — streamrip grava token_expiry sem aspas.
    def extract(key):
        m = re.search(rf'^{re.escape(key)}\s*=\s*"?([^"\n\s]+)"?', content, re.MULTILINE)
        return m.group(1) if m else ""

    access_token  = extract("access_token")
    refresh_token = extract("refresh_token")
    token_expiry  = extract("token_expiry")

    if not access_token:
        _err("Token Tidal ausente. Use o botão 'Novo Login OAuth' no MusicSage.")

    from datetime import datetime, timezone
    expiry_dt = datetime.fromtimestamp(int(float(token_expiry or 0)), tz=timezone.utc) if token_expiry else None

    session = tidalapi.Session()
    try:
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)
        if not session.check_login():
            raise Exception("check_login() returned False")
    except Exception as e:
        _err(f"Sessão inválida: {e}. Use o botão 'Novo Login OAuth' no MusicSage.")

    # check_login() pode ter disparado um refresh silencioso dentro do tidalapi
    # (access_token trocado só na sessão em memória) — persistir agora, senão o
    # refresh é perdido quando o processo termina e o próximo check já falha.
    _save_refreshed_tokens(content, access_token, refresh_token, token_expiry, session)

    return session


# ── Helpers ───────────────────────────────────────────────────────────────────

def _err(msg: str, code: int = 1):
    print(json.dumps({"error": msg}))
    sys.exit(code)


def _out(data):
    print(json.dumps(data, ensure_ascii=False))


def _artist_picture(artist) -> str | None:
    """Tenta extrair URL de imagem do artista."""
    try:
        pic = artist.picture
        if pic:
            # tidalapi: picture é um UUID; URL pública via image_url()
            return artist.image(320)
    except Exception:
        pass
    return None


def _album_year(album) -> int | None:
    try:
        return album.release_date.year if album.release_date else None
    except Exception:
        return None


# ── Comandos ──────────────────────────────────────────────────────────────────

def cmd_search_artists(query: str):
    session = get_session()
    try:
        results = session.search(query, [__import__("tidalapi").Artist])
        artists = results.get("artists", []) if isinstance(results, dict) else getattr(results, "artists", [])
    except Exception as e:
        _err(f"Erro na busca: {e}")

    out = []
    for a in (artists or [])[:10]:
        out.append({
            "id":      a.id,
            "name":    a.name,
            "picture": _artist_picture(a),
        })
    _out(out)


def cmd_list_albums(artist_id: str):
    import tidalapi
    session = get_session()
    try:
        artist = tidalapi.Artist(session, artist_id)
        albums = list(artist.get_albums()) or []
        if not albums:
            albums = list(artist.get_albums_ep_singles()) or []
    except Exception as e:
        _err(f"Erro ao buscar álbuns: {e}")

    out = []
    for a in albums:
        out.append({
            "id":   a.id,
            "name": a.name,
            "year": _album_year(a),
            "url":  f"https://tidal.com/browse/album/{a.id}",
        })
    _out(out)


def cmd_album_info(album_id: str):
    """Metadados de um álbum avulso — usado no download por link do Tidal."""
    import tidalapi
    session = get_session()
    try:
        album = tidalapi.Album(session, album_id)
        name = album.name
    except Exception as e:
        _err(f"Erro ao buscar álbum: {e}")

    if not name:
        _err(f"Álbum {album_id} não encontrado")

    try:
        artist = album.artist.name if album.artist else None
    except Exception:
        artist = None

    _out({
        "id":     album_id,
        "name":   name,
        "artist": artist,
        "year":   _album_year(album),
        "url":    f"https://tidal.com/browse/album/{album_id}",
    })


def _rip_major_version(rip_bin: str) -> int:
    """Retorna a versão major do rip (1 ou 2). Default 1 em caso de erro."""
    try:
        r = subprocess.run([rip_bin, "--version"], capture_output=True, text=True, timeout=5)
        out = r.stdout + r.stderr
        m = re.search(r"(\d+)\.\d+", out)
        return int(m.group(1)) if m else 1
    except Exception:
        return 1


def _rip_url(rip_bin: str, url: str, quality: int, env: dict, major_ver: int,
             download_dir: str) -> subprocess.CompletedProcess:
    """Executa 'rip url [...] <url>' e retorna o CompletedProcess."""
    if major_ver == 1:
        # v1.x: suporta --max-quality, --ignore-db, --directory
        cmd = [rip_bin, "url", "--ignore-db",
               "--max-quality", str(quality),
               "--directory", download_dir, url]
    else:
        # v2.x: qualidade e pasta via config.toml; não suporta --ignore-db
        cmd = [rip_bin, "url", url]
    return subprocess.run(cmd, cwd=str(AGENT_DIR), env=env, capture_output=True, text=True)


def _fetch_album(session, album_id: str):
    """Carrega metadados do álbum via tidalapi. None se falhar (não bloqueia o download)."""
    try:
        import tidalapi
        album = tidalapi.Album(session, str(album_id))
        album.get()
        return album if album.name else None
    except Exception:
        return None


def _expected_track_count(album) -> int | None:
    if album is None:
        return None
    n = getattr(album, "num_tracks", None)
    if isinstance(n, int) and n > 0:
        return n
    try:
        tracks = album.tracks()
        return len(tracks) if tracks else None
    except Exception:
        return None


def _find_album_folder(download_dir: str, album) -> Path | None:
    base = Path(download_dir)
    if not base.exists() or album is None or not album.name:
        return None
    name = album.name.lower()
    for d in base.iterdir():
        if d.is_dir() and name in d.name.lower():
            return d
    return None


def _count_album_tracks(download_dir: str, album) -> int | None:
    """Conta arquivos de áudio na pasta do álbum. None se a pasta não for achada."""
    folder = _find_album_folder(download_dir, album)
    if folder is None:
        return None
    return sum(
        1 for f in folder.rglob("*")
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS
    )


def _download_once(rip_bin: str, url: str, env: dict, major_ver: int,
                   download_dir: str, quality_fallbacks: list[int]) -> tuple[bool, int | None, str]:
    """Uma passada de rip (com fallback de qualidade no v1.x).
    Retorna (baixou_áudio_novo, qualidade_usada, saída_combinada)."""
    last_combined = ""
    ok = False
    used_quality = None
    for q in quality_fallbacks:
        started_at = time.time() - 1  # margem p/ resolução do mtime do filesystem
        r = _rip_url(rip_bin, url, q, env, major_ver, download_dir)
        combined = (r.stderr.strip() + "\n" + r.stdout.strip()).strip()
        last_combined = combined
        if r.returncode == 0:
            if _has_new_audio_file(download_dir, started_at):
                ok = True
                used_quality = q
                break
            # exit code 0 mas nenhum áudio novo — provavelmente baixou só capa/metadados
            last_combined = (combined + "\n[TideCaller] rip retornou sucesso mas "
                              "nenhum arquivo de áudio foi criado.").strip()
        if major_ver == 1:
            # Continua para próxima qualidade se erro sugere tier indisponível
            low = combined.lower()
            if not any(kw in low for kw in ("quality", "unavailable", "not available",
                                             "401", "403", "tier", "subscription",
                                             "not found", "no tracks")):
                break  # Erro diferente — não tenta fallback
        # v2.x: uma única tentativa (qualidade via config)
    return ok, used_quality, last_combined


def cmd_download_albums(album_ids: list[str]):
    _patch_config_quality()  # garantir quality=1
    _patch_config_databases()
    # Refrescar o access_token antes de rodar o rip (o token real do Tidal expira
    # bem mais rápido que isso — não confiar em um expiry fixo)
    session = _refresh_and_save_tokens()
    if session is None:
        for aid in album_ids:
            print(json.dumps({"albumId": aid, "ok": False,
                              "error": "Token Tidal inválido ou expirado. Refaça o login OAuth."}),
                  flush=True)
        _out({"done": True, "results": []})
        return
    # Prefere o binário do venv; cai para o rip do sistema se não existir
    _venv_rip = AGENT_DIR / ".venv_tidal" / "bin" / "rip"
    rip_bin = str(_venv_rip) if _venv_rip.exists() else "rip"
    major_ver = _rip_major_version(rip_bin)
    # Pasta de destino: env var TIDECALLER_DOWNLOADS ou valor do config.toml
    download_dir = os.environ.get("TIDECALLER_DOWNLOADS") or str(AGENT_DIR / "downloads")
    _patch_config_download_folder(download_dir)  # necessário no v2.x — ver docstring
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": str(AGENT_DIR / "config" / ".config"),
    }
    # Qualidades Tidal: 3=HiFi+ (MQA), 2=LOSSLESS (FLAC), 1=HIGH (320kbps AAC), 0=LOW (96kbps AAC)
    # v1.x: tenta do melhor para o pior via --max-quality
    # v2.x: qualidade definida no config.toml (não aceita flag CLI)
    QUALITY_FALLBACKS = [3, 2, 1, 0] if major_ver == 1 else [1]
    # O rip trata falha por faixa como aviso e segue (exit 0). Sem os DBs de
    # estado, re-rodar o álbum baixa o que faltou — para quando não há progresso.
    MAX_ATTEMPTS = 3

    results = []
    for aid in album_ids:
        url = f"https://tidal.com/browse/album/{aid}"
        try:
            album = _fetch_album(session, aid)
            expected = _expected_track_count(album)

            ok = False
            used_quality = None
            last_combined = ""
            downloaded = None
            complete = None
            prev = 0
            attempts = MAX_ATTEMPTS if expected else 1
            attempt = 0
            for attempt in range(1, attempts + 1):
                if attempt > 1:
                    time.sleep(5)
                    # Token pode ter expirado no meio do álbum — renovar antes de retry
                    session = _refresh_and_save_tokens() or session
                ok, used_quality, last_combined = _download_once(
                    rip_bin, url, env, major_ver, download_dir, QUALITY_FALLBACKS)
                if album is not None:
                    downloaded = _count_album_tracks(download_dir, album)
                if expected and downloaded is not None and downloaded < expected:
                    complete = False
                    progressed = downloaded > prev
                    if attempt < attempts and (progressed or attempt == 1):
                        prev = downloaded
                        continue  # ainda faltam faixas e vale outra passada
                    break
                complete = (downloaded >= expected) if (expected and downloaded is not None) else None
                break

            ok = ok and complete is not False
            if ok:
                err_msg = None
            elif complete is False:
                err_msg = (f"álbum incompleto: {downloaded}/{expected} faixas "
                           f"após {attempt} tentativa(s)")
            else:
                err_msg = last_combined[-500:] if last_combined else None

            results.append({
                "albumId": aid, "ok": ok, "url": url,
                "quality": used_quality,
                "tracksExpected": expected,
                "tracksDownloaded": downloaded,
                "complete": complete,
                "error": err_msg,
                "output": last_combined[-300:] if ok else None,
            })
        except Exception as e:
            results.append({"albumId": aid, "ok": False, "error": str(e), "url": url})
        # Flush uma linha por vez para que o chamador acompanhe o progresso
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    # Resumo final
    _out({"done": True, "results": results})


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args:
        _err("Uso: tidal_query.py <comando> [args...]")

    cmd = args[0]
    rest = args[1:]

    if cmd == "search-artists":
        if not rest:
            _err("search-artists requer QUERY")
        cmd_search_artists(" ".join(rest))

    elif cmd == "list-albums":
        if not rest:
            _err("list-albums requer ARTIST_ID")
        cmd_list_albums(rest[0])

    elif cmd == "album-info":
        if not rest:
            _err("album-info requer ALBUM_ID")
        cmd_album_info(rest[0])

    elif cmd == "download-albums":
        if not rest:
            _err("download-albums requer ao menos um ALBUM_ID")
        cmd_download_albums(rest)

    else:
        _err(f"Comando desconhecido: {cmd}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _err("Cancelado", 0)
    except Exception as e:
        _err(str(e))
