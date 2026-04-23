#!/usr/bin/env python3
"""
tidal_query.py — Bridge JSON para o MusicSage API.

Comandos:
  python tidal_query.py search-artists QUERY        → JSON array de artistas
  python tidal_query.py list-albums    ARTIST_ID    → JSON array de álbuns
  python tidal_query.py download-albums ALBUM_ID... → baixa e imprime status JSON

Saída sempre é JSON válido em stdout; erros como {"error": "..."} com exit 1.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR  = Path(__file__).parent.absolute()
AGENT_DIR   = SCRIPT_DIR.parent
CONFIG_TOML = AGENT_DIR / "config" / ".config" / "streamrip" / "config.toml"

# Qualidade alvo para Tidal: 3 = HiFi (FLAC) — requer plano HiFi ou superior
_TARGET_TIDAL_QUALITY = 3


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


def _refresh_and_save_tokens() -> bool:
    """
    Carrega sessão tidalapi, deixa o refresh automático acontecer se necessário,
    e sobrescreve access_token/token_expiry no config.toml com os valores atualizados.
    Retorna True se a sessão está válida, False em caso de falha.
    """
    if not CONFIG_TOML.exists():
        return False
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
            return False

        session = tidalapi.Session()
        expiry_dt = datetime.fromtimestamp(int(float(token_expiry or 0)), tz=timezone.utc) if token_expiry else None
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)

        if not session.check_login():
            return False

        # Salvar tokens atualizados (tidalapi pode ter feito refresh automático)
        new_access  = getattr(session, "access_token",  None) or access_token
        # Definir expiry como agora+7d para que o streamrip NÃO tente renovar
        # com as próprias credenciais (client_id diferente → 403)
        import time as _time
        fake_expiry_ts = str(int(_time.time()) + 7 * 24 * 3600)

        updated = content
        updated = re.sub(r'(?m)^(access_token\s*=\s*).*$',
                         f'access_token = "{new_access}"', updated)
        updated = re.sub(r'(?m)^(token_expiry\s*=\s*).*$',
                         f'token_expiry = "{fake_expiry_ts}"', updated)
        if updated != content:
            CONFIG_TOML.write_text(updated, encoding="utf-8")

        return True
    except Exception as e:
        sys.stderr.write(f"[WARN] _refresh_and_save_tokens: {e}\n")
        return False


# ── Sessão ────────────────────────────────────────────────────────────────────

def get_session():
    try:
        import tidalapi
    except ImportError:
        _err("tidalapi não instalado. Execute o setup do TideCaller.")

    content = CONFIG_TOML.read_text(encoding="utf-8") if CONFIG_TOML.exists() else ""

    def extract(key):
        m = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]*)"', content, re.MULTILINE)
        return m.group(1) if m else ""

    access_token  = extract("access_token")
    refresh_token = extract("refresh_token")
    token_expiry  = extract("token_expiry")

    if not access_token:
        _err("Token Tidal ausente. Use o botão 'Novo Login OAuth' no MusicSage.")

    from datetime import datetime, timezone
    expiry_dt = datetime.fromtimestamp(int(token_expiry or 0), tz=timezone.utc) if token_expiry else None

    session = tidalapi.Session()
    try:
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)
        if not session.check_login():
            raise Exception("check_login() returned False")
    except Exception as e:
        _err(f"Sessão inválida: {e}. Use o botão 'Novo Login OAuth' no MusicSage.")

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


def cmd_download_albums(album_ids: list[str]):
    _patch_config_quality()  # garantir quality=1
    # Refrescar o access_token antes de rodar o rip (token expira a cada ~7 dias)
    token_ok = _refresh_and_save_tokens()
    if not token_ok:
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
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": str(AGENT_DIR / "config" / ".config"),
    }
    # Qualidades Tidal: 3=HiFi+ (MQA), 2=LOSSLESS (FLAC), 1=HIGH (320kbps AAC), 0=LOW (96kbps AAC)
    # v1.x: tenta do melhor para o pior via --max-quality
    # v2.x: qualidade definida no config.toml (não aceita flag CLI)
    QUALITY_FALLBACKS = [3, 2, 1, 0] if major_ver == 1 else [1]

    results = []
    for aid in album_ids:
        url = f"https://tidal.com/browse/album/{aid}"
        try:
            last_combined = ""
            ok = False
            used_quality = None
            for q in QUALITY_FALLBACKS:
                r = _rip_url(rip_bin, url, q, env, major_ver, download_dir)
                combined = (r.stderr.strip() + "\n" + r.stdout.strip()).strip()
                last_combined = combined
                if r.returncode == 0:
                    ok = True
                    used_quality = q
                    break
                if major_ver == 1:
                    # Continua para próxima qualidade se erro sugere tier indisponível
                    low = combined.lower()
                    if not any(kw in low for kw in ("quality", "unavailable", "not available",
                                                     "401", "403", "tier", "subscription",
                                                     "not found", "no tracks")):
                        break  # Erro diferente — não tenta fallback
                # v2.x: uma única tentativa (qualidade via config)

            err_msg = last_combined[-500:] if last_combined else None
            results.append({
                "albumId": aid, "ok": ok, "url": url,
                "quality": used_quality,
                "error": None if ok else err_msg,
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
