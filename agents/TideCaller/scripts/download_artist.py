#!/usr/bin/env python3
from __future__ import annotations
"""
TideCaller — Download interativo de artista via Tidal

Uso:
  python download_artist.py               → pergunta o nome interativamente
  python download_artist.py "Metallica"   → busca direto pelo nome
"""

import sys
import re
import subprocess
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.absolute()
AGENT_DIR  = SCRIPT_DIR.parent
CONFIG_TOML = AGENT_DIR / "config" / ".config" / "streamrip" / "config.toml"

# ── Cores ─────────────────────────────────────────────────────────────────────
R  = "\033[31m"
G  = "\033[32m"
Y  = "\033[33m"
B  = "\033[34m"
C  = "\033[36m"
W  = "\033[1m"
NC = "\033[0m"

def bold(s): return f"{W}{s}{NC}"
def cyan(s): return f"{C}{s}{NC}"
def green(s): return f"{G}{s}{NC}"
def yellow(s): return f"{Y}{s}{NC}"
def red(s): return f"{R}{s}{NC}"


# ── Importar tidalapi ─────────────────────────────────────────────────────────
try:
    import tidalapi
except ImportError:
    print(red("❌ tidalapi não está instalado."))
    print("   Execute: pip install tidalapi")
    sys.exit(1)


# ── Sessão ────────────────────────────────────────────────────────────────────
def get_session() -> tidalapi.Session:
    """Carrega sessão a partir dos tokens do config.toml."""
    content = CONFIG_TOML.read_text(encoding="utf-8")

    def extract(key):
        m = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]*)"', content, re.MULTILINE)
        return m.group(1) if m else ""

    access_token  = extract("access_token")
    refresh_token = extract("refresh_token")
    token_expiry  = extract("token_expiry")

    if not access_token:
        print(red("❌ Sem access_token no config.toml."))
        print(f"   Execute: {cyan('node plex-cli.js tidecaller:refresh-token')}")
        sys.exit(1)

    from datetime import datetime, timezone
    expiry_dt = datetime.fromtimestamp(int(token_expiry or 0), tz=timezone.utc) if token_expiry else None

    session = tidalapi.Session()
    try:
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)
        if not session.check_login():
            raise Exception("check_login() returned False")
    except Exception as e:
        print(red(f"❌ Sessão inválida: {e}"))
        print(f"   Execute: {cyan('node plex-cli.js tidecaller:refresh-token')}")
        sys.exit(1)

    return session


# ── Busca ─────────────────────────────────────────────────────────────────────
def search_artist(session: tidalapi.Session, query: str) -> list:
    """Retorna lista de artistas encontrados."""
    results = session.search(query, [tidalapi.Artist])
    # tidalapi.search() retorna dict com chaves de string: {'artists': [...], 'albums': [...], ...}
    if isinstance(results, dict):
        artists = results.get("artists", []) or []
    else:
        # fallback para versões que retornavam objeto com atributos
        artists = getattr(results, "artists", []) or []
    return artists[:10]


def get_albums(artist: tidalapi.Artist) -> list:
    """Retorna álbuns de um artista (sem singles/EPs a menos que não haja álbuns)."""
    try:
        albums = artist.get_albums()
        if not albums:
            albums = artist.get_albums_ep_singles()
        return list(albums)
    except Exception as e:
        print(yellow(f"⚠️  Erro ao buscar álbuns: {e}"))
        return []


# ── UI helpers ────────────────────────────────────────────────────────────────
def ask(prompt: str, default: str = "") -> str:
    try:
        val = input(prompt).strip()
        return val if val else default
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def pick(options: list, prompt: str = "Escolha") -> int:
    """Exibe lista numerada e pede escolha. Retorna índice (0-based)."""
    for i, opt in enumerate(options):
        print(f"  {cyan(str(i + 1).rjust(2))}. {opt}")
    print()
    while True:
        raw = ask(f"{prompt} (número): ")
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw) - 1
        print(red(f"   Digite um número entre 1 e {len(options)}."))


def pick_multi(options: list, prompt: str = "Escolha") -> list[int]:
    """
    Exibe lista numerada e permite seleção múltipla.
    Retorna lista de índices (0-based).
    """
    for i, opt in enumerate(options):
        print(f"  {cyan(str(i + 1).rjust(2))}. {opt}")
    print()
    hint = 'Digite os números separados por vírgula, ou "all" para todos.'
    print(f"  {yellow(hint)}")
    print()
    while True:
        raw = ask(f"{prompt}: ").strip()
        if raw.lower() in ("all", "todos", "a"):
            return list(range(len(options)))
        parts = [p.strip() for p in raw.replace(";", ",").split(",")]
        indices = []
        valid = True
        for p in parts:
            if p.isdigit() and 1 <= int(p) <= len(options):
                idx = int(p) - 1
                if idx not in indices:
                    indices.append(idx)
            else:
                print(red(f"   Valor inválido: '{p}'. Digite números entre 1 e {len(options)}."))
                valid = False
                break
        if valid and indices:
            return indices


# ── Download via streamrip (venv) ───────────────────────────────────────────
AUDIO_EXTS = {'.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aiff', '.aac'}


def _download_dir() -> Path:
    """Lê a pasta de download do config.toml."""
    try:
        content = CONFIG_TOML.read_text(encoding="utf-8")
        m = re.search(r'^folder\s*=\s*"([^"]+)"', content, re.MULTILINE)
        if m:
            return Path(m.group(1))
    except Exception:
        pass
    return Path("/downloads/tidecaller")


def _find_album_folder(album) -> Path | None:
    """Procura a pasta criada para o álbum na pasta de downloads."""
    base = _download_dir()
    if not base.exists():
        return None
    title_lower = album.name.lower()
    for d in base.iterdir():
        if d.is_dir() and title_lower in d.name.lower():
            return d
    return None


def _has_audio(folder: Path) -> bool:
    return any(
        f.suffix.lower() in AUDIO_EXTS
        for f in folder.rglob("*")
        if f.is_file()
    )


def _count_audio(folder: Path) -> int:
    return sum(
        1 for f in folder.rglob("*")
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS
    )


def _expected_tracks(album) -> int | None:
    n = getattr(album, "num_tracks", None)
    if isinstance(n, int) and n > 0:
        return n
    try:
        tracks = album.tracks()
        return len(tracks) if tracks else None
    except Exception:
        return None


def _ensure_config_exists():
    """Cria o config.toml a partir do template quando não existe (streamrip
    rodando com defaults tem update check ligado, que aborta o download sem
    saída pro GitHub)."""
    if CONFIG_TOML.exists():
        return
    template = AGENT_DIR / "setup" / "config.toml.template"
    if not template.exists():
        return
    try:
        CONFIG_TOML.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_TOML.write_text(
            template.read_text(encoding="utf-8").replace("__AGENT_DIR__", str(AGENT_DIR)),
            encoding="utf-8",
        )
    except Exception:
        pass


def _patch_config_updates():
    """Desativa o update check do streamrip ([misc] check_for_updates) —
    ele bate em api.github.com antes de cada download e o timeout aborta
    o álbum inteiro quando não há saída pro GitHub."""
    if not CONFIG_TOML.exists():
        return
    try:
        text = CONFIG_TOML.read_text(encoding="utf-8")
        original = text
        if re.search(r'(?m)^\[misc\]', text):
            if re.search(r'(?m)^check_for_updates\s*=', text):
                text = re.sub(r'(?m)^(check_for_updates\s*=\s*)true', r'\g<1>false', text)
            else:
                text = re.sub(r'(?m)^(\[misc\]\n)', r'\1check_for_updates = false\n', text, count=1)
        else:
            text += "\n[misc]\ncheck_for_updates = false\n"
        if text != original:
            CONFIG_TOML.write_text(text, encoding="utf-8")
    except Exception:
        pass


def _patch_config_databases():
    """
    Desativa os bancos de estado do streamrip (downloads.db/failed_downloads.db).
    downloads.db pulava faixas registradas como baixadas mesmo com o arquivo
    movido depois; failed_downloads.db pulava para sempre faixas que falharam
    uma vez (token expirado, 429). Melhor re-baixar do que ficar sem faixa.
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


# O rip trata falha por faixa como aviso e segue (exit 0). Sem os DBs de
# estado, re-rodar o álbum baixa o que faltou — para quando não há progresso.
MAX_ALBUM_ATTEMPTS = 3


def download_url(url: str, album=None) -> bool:
    """Baixa uma URL do Tidal via streamrip do venv e verifica completude do álbum."""
    import os
    rip_bin = AGENT_DIR / ".venv_tidal" / "bin" / "rip"
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": str(AGENT_DIR / "config" / ".config"),
    }
    expected = _expected_tracks(album) if album is not None else None
    attempts = MAX_ALBUM_ATTEMPTS if expected else 1
    prev = 0
    downloaded = None

    for attempt in range(1, attempts + 1):
        if attempt > 1:
            time.sleep(5)
        result = subprocess.run(
            [str(rip_bin), "-q", "3", "url", url],
            cwd=str(AGENT_DIR),
            env=env,
        )
        if result.returncode != 0:
            if attempt < attempts:
                print(yellow(f"  ⚠️  rip saiu com código {result.returncode} — "
                             f"tentando novamente ({attempt + 1}/{attempts})..."))
                continue
            return False

        if album is None:
            return True

        # streamrip às vezes retorna 0 mesmo sem baixar áudio (apenas cover.jpg).
        # Verificar se há arquivos de áudio na pasta do álbum.
        folder = _find_album_folder(album)
        if folder is None:
            print(yellow("  ⚠️  Pasta do álbum não encontrada após download."))
            return False
        downloaded = _count_audio(folder)
        if downloaded == 0:
            print(yellow(f"  ⚠️  Nenhum arquivo de áudio em: {folder.name}"))
            print(yellow("      (apenas cover.jpg? Token expirado ou faixa indisponível)"))
            if attempt < attempts:
                print(yellow(f"      tentando novamente ({attempt + 1}/{attempts})..."))
                continue
            return False

        if expected and downloaded < expected:
            print(yellow(f"  ⚠️  Incompleto: {downloaded}/{expected} faixas."))
            progressed = downloaded > prev
            if attempt < attempts and (progressed or attempt == 1):
                print(yellow(f"      baixando de novo ({attempt + 1}/{attempts})..."))
                prev = downloaded
                continue
            print(red(f"  ❌  Faltaram {expected - downloaded} faixa(s) após {attempt} tentativa(s)."))
            return False

        # Completo (ou expected desconhecido, mas há áudio)
        return True

    return False


def album_label(album) -> str:
    year = ""
    try:
        if album.release_date:
            year = f" ({album.release_date.year})"
    except Exception:
        pass
    return f"{album.name}{year}"


def album_url(album) -> str:
    return f"https://tidal.com/browse/album/{album.id}"


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print()
    print(bold(f"{'━' * 54}"))
    print(bold(f"  🌊 TideCaller — Download Interativo"))
    print(bold(f"{'━' * 54}"))
    print()

    # ── 1. Nome do artista ────────────────────────────────────────────────────
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    if not query:
        query = ask(f"{cyan('Nome do artista')}: ")
    if not query:
        sys.exit(0)

    print(f"\n🔍 Buscando {bold(query)}...\n")

    session = get_session()
    artists = search_artist(session, query)

    if not artists:
        print(red(f"❌ Nenhum artista encontrado para '{query}'."))
        sys.exit(1)

    # ── 2. Selecionar artista ─────────────────────────────────────────────────
    if len(artists) == 1:
        artist = artists[0]
        print(f"✅ Artista encontrado: {bold(artist.name)}\n")
    else:
        print(f"Encontrados {len(artists)} artistas:\n")
        idx = pick([a.name for a in artists], "Qual artista")
        artist = artists[idx]
        print()

    # ── 3. Buscar álbuns ──────────────────────────────────────────────────────
    print(f"📀 Buscando álbuns de {bold(artist.name)}...\n")
    albums = get_albums(artist)

    if not albums:
        print(red(f"❌ Nenhum álbum encontrado para {artist.name}."))
        sys.exit(1)

    print(f"  {len(albums)} álbum(ns) encontrado(s).\n")

    # ── 4. Discografia completa ou seleção ────────────────────────────────────
    print(f"  {cyan('1')}. Discografia completa ({len(albums)} álbuns)")
    print(f"  {cyan('2')}. Escolher álbuns específicos")
    print()
    mode = ask("Opção [1/2]: ", default="1")

    print()
    if mode == "2":
        labels = [album_label(a) for a in albums]
        indices = pick_multi(labels, "Álbuns para baixar (ex: 1,3,5 ou all)")
        selected = [albums[i] for i in indices]
    else:
        selected = albums

    # ── 5. Confirmar ──────────────────────────────────────────────────────────
    print()
    print(f"{'─' * 54}")
    print(bold(f"  📥 {len(selected)} álbum(ns) para baixar:"))
    for a in selected:
        print(f"    • {album_label(a)}")
    print(f"{'─' * 54}")
    print()

    confirm = ask("Confirmar download? [S/n]: ", default="s").lower()
    if confirm not in ("s", "sim", "y", "yes", ""):
        print(yellow("Cancelado."))
        sys.exit(0)

    print()

    # ── 6. Baixar ─────────────────────────────────────────────────────────────
    _ensure_config_exists()
    _patch_config_updates()
    _patch_config_databases()
    ok = 0
    fail = 0
    for i, album in enumerate(selected, 1):
        url = album_url(album)
        label = album_label(album)
        print(f"[{i}/{len(selected)}] {bold(label)}")
        print(f"  {C}{url}{NC}")
        if download_url(url, album):
            print(green(f"  ✅ Concluído\n"))
            ok += 1
        else:
            print(red(f"  ❌ Falhou\n"))
            fail += 1

    # ── 7. Resumo ─────────────────────────────────────────────────────────────
    print(f"{'━' * 54}")
    print(f"  {green(f'✅ {ok} baixado(s)')}  {red(f'❌ {fail} falha(s)') if fail else ''}")
    print(f"{'━' * 54}")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{yellow('⚠️  Cancelado.')}")
        sys.exit(0)
