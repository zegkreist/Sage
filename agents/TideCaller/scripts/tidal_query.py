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


def cmd_download_albums(album_ids: list[str]):
    # Prefere o binário do venv; cai para o rip do sistema se não existir
    _venv_rip = AGENT_DIR / ".venv_tidal" / "bin" / "rip"
    rip_bin = str(_venv_rip) if _venv_rip.exists() else "rip"
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": str(AGENT_DIR / "config" / ".config"),
    }
    results = []
    for aid in album_ids:
        url = f"https://tidal.com/browse/album/{aid}"
        try:
            r = subprocess.run(
                [rip_bin, "url", url],
                cwd=str(AGENT_DIR),
                env=env,
                capture_output=True,
                text=True,
            )
            ok = r.returncode == 0
            results.append({"albumId": aid, "ok": ok, "url": url,
                             "error": r.stderr.strip()[-300:] if not ok and r.stderr else None})
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
