#!/usr/bin/env python3
"""
TideCaller — Gerenciamento de tokens Tidal para o streamrip.

Modos:
  python get_tidal_tokens.py          → refresh automático se possível, OAuth se necessário
  python get_tidal_tokens.py --force  → força novo login OAuth independente do estado atual
  python get_tidal_tokens.py --check  → só verifica expiração, sai com código 1 se expirado

Após obter tokens, substitui automaticamente os valores no config.toml.
"""

import sys
import re
import json
import time
from pathlib import Path

# ── Caminhos ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent.absolute()
AGENT_DIR = SCRIPT_DIR.parent
CONFIG_TOML = AGENT_DIR / "config" / ".config" / "streamrip" / "config.toml"
CONFIG_TEMPLATE = SCRIPT_DIR / "config.toml.template"
TOKENS_BACKUP = SCRIPT_DIR / "tidal_tokens.txt"

# ── Importação com mensagem amigável ──────────────────────────────────────────
try:
    import tidalapi
except ImportError:
    print("❌ tidalapi não está instalado.")
    print("   Execute: pip install tidalapi  (ou use o venv: .venv_tidal)")
    sys.exit(1)


# ── Utilitários ───────────────────────────────────────────────────────────────

def _bootstrap_config_from_template() -> bool:
    """
    Cria config.toml a partir do config.toml.template quando ele ainda não existe
    (ex: container com tidalapi/streamrip pré-instalados, onde o ensure_setup.sh
    pula o setup.sh — que normalmente é quem cria esse arquivo — achando que não
    há nada a fazer).
    """
    if not CONFIG_TEMPLATE.exists():
        print(f"⚠️  config.toml.template não encontrado em: {CONFIG_TEMPLATE}")
        return False
    CONFIG_TOML.parent.mkdir(parents=True, exist_ok=True)
    template_text = CONFIG_TEMPLATE.read_text(encoding="utf-8")
    CONFIG_TOML.write_text(template_text.replace("__AGENT_DIR__", str(AGENT_DIR)), encoding="utf-8")
    print(f"📄 config.toml criado a partir do template: {CONFIG_TOML}")
    return True


def read_config() -> str:
    """Lê o conteúdo atual do config.toml, criando a partir do template se necessário."""
    if not CONFIG_TOML.exists():
        if not _bootstrap_config_from_template():
            print(f"⚠️  config.toml não encontrado em: {CONFIG_TOML}")
            return ""
    return CONFIG_TOML.read_text(encoding="utf-8")


def write_tokens_to_config(user_id, country_code, access_token, refresh_token, expiry):
    """
    Substitui os 5 campos do bloco [tidal] no config.toml preservando
    todos os comentários e demais seções.
    """
    content = read_config()
    if not content:
        print("⚠️  Não foi possível ler config.toml — tokens salvos apenas em backup.")
        return False

    fields = {
        "user_id": str(user_id),
        "country_code": str(country_code),
        "access_token": str(access_token),
        "refresh_token": str(refresh_token),
        "token_expiry": str(expiry),
    }

    updated = content
    for key, value in fields.items():
        # Substitui  key = "qualquer_coisa"  ou  key = 1234  (com ou sem aspas)
        # Necessário porque o streamrip grava user_id e token_expiry sem aspas
        pattern = rf'^({re.escape(key)}\s*=\s*)(?:"[^"]*"|\S+)'
        replacement = rf'\1"{value}"'
        new = re.sub(pattern, replacement, updated, flags=re.MULTILINE)
        if new == updated:
            print(f"  ⚠️  Campo '{key}' não encontrado no config.toml")
        updated = new

    CONFIG_TOML.write_text(updated, encoding="utf-8")
    print(f"✅ config.toml atualizado: {CONFIG_TOML}")
    return True


def save_backup(user_id, country_code, access_token, refresh_token, expiry):
    """Salva cópia de segurança dos tokens em tidal_tokens.txt."""
    TOKENS_BACKUP.write_text(
        f'[tidal]\n'
        f'user_id = "{user_id}"\n'
        f'country_code = "{country_code}"\n'
        f'access_token = "{access_token}"\n'
        f'refresh_token = "{refresh_token}"\n'
        f'token_expiry = "{expiry}"\n'
        f'quality = 3\n'
        f'download_videos = true\n',
        encoding="utf-8",
    )
    print(f"💾 Backup salvo em: {TOKENS_BACKUP}")


def get_expiry_from_config() -> int:
    """Lê token_expiry do config.toml. Retorna 0 se não encontrar."""
    content = read_config()
    # Aceita "1234", "1234.0", 1234, 1234.0 (streamrip grava sem aspas e com casas decimais)
    m = re.search(r'^token_expiry\s*=\s*"?(\d+)', content, re.MULTILINE)
    return int(m.group(1)) if m else 0


def is_token_expired(buffer_seconds: int = 300) -> bool:
    """Retorna True se o token expira nos próximos buffer_seconds segundos."""
    expiry = get_expiry_from_config()
    if expiry == 0:
        return True  # sem info = trata como expirado
    remaining = expiry - int(time.time())
    if remaining <= buffer_seconds:
        print(f"⏰ Token expira em {max(0, remaining)}s (buffer: {buffer_seconds}s) — renovação necessária.")
        return True
    days = remaining // 86400
    hours = (remaining % 86400) // 3600
    print(f"✅ Token válido por mais {days}d {hours}h.")
    return False


def load_session_from_config() -> "tidalapi.Session | None":
    """
    Tenta reutilizar tokens existentes do config.toml.
    Se o tidalapi conseguir fazer refresh automaticamente, retorna a sessão.
    Retorna None se falhar.
    """
    content = read_config()

    def extract(key):
        # Tenta formato com aspas primeiro; fallback para valor sem aspas
        m = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]*)"', content, re.MULTILINE)
        if m:
            return m.group(1)
        m = re.search(rf'^{re.escape(key)}\s*=\s*(\S+)', content, re.MULTILINE)
        return m.group(1) if m else ""

    access_token = extract("access_token")
    refresh_token = extract("refresh_token")
    token_expiry = extract("token_expiry")

    if not access_token or not refresh_token:
        return None

    print("🔄 Tentando reutilizar/renovar sessão existente...")
    session = tidalapi.Session()
    try:
        # load_oauth_session aceita (token_type, access_token, refresh_token, expiry_time)
        # expiry_time deve ser datetime; convertemos de unix timestamp
        from datetime import datetime, timezone
        expiry_dt = datetime.fromtimestamp(int(token_expiry or 0), tz=timezone.utc) if token_expiry else None
        session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)
        if session.check_login():
            print("✅ Sessão renovada com sucesso (sem interação necessária).")
            return session
    except Exception as e:
        print(f"  ↳ Falha ao reutilizar sessão: {e}")
    return None


def clickable_link(url: str, text: str = None) -> str:
    """Retorna URL com sequência OSC 8 para ser clicável em terminais modernos."""
    label = text or url
    return f"\033]8;;{url}\033\\{label}\033]8;;\033\\"


def json_emit(obj: dict):
    """Emite um objeto JSON numa linha — lido pelo Node.js em modo --json."""
    print(json.dumps(obj), flush=True)


def oauth_login(json_mode: bool = False) -> "tidalapi.Session":
    """Inicia fluxo OAuth interativo. Requer que o usuário abra o link."""
    session = tidalapi.Session()

    if not json_mode:
        print()
        print("🔐 Iniciando autenticação OAuth2...")
        print()

    login, future = session.login_oauth()

    url = f"https://{login.verification_uri_complete}"
    user_code = login.user_code

    if json_mode:
        # Node.js vai parsear esta linha e responder ao frontend imediatamente
        json_emit({"type": "oauth_url", "url": url, "user_code": user_code})
    else:
        print("─" * 60)
        print(f"  👉  {clickable_link(url)}  ← clique aqui ou copie o link")
        print()
        print(f"  Código: {user_code}")
        print("─" * 60)
        print()
        # Tentar abrir o browser automaticamente (falha silenciosamente no container)
        try:
            import subprocess
            subprocess.call(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        print()
        print("⏳ Aguardando autorização no browser...")

    try:
        future.result()
    except Exception as e:
        if json_mode:
            json_emit({"type": "error", "message": str(e)})
        else:
            print(f"\n❌ Erro durante autenticação: {e}")
        sys.exit(1)

    if not session.check_login():
        if json_mode:
            json_emit({"type": "error", "message": "check_login() falhou após autorização"})
        else:
            print("\n❌ Falha no login. Tente novamente.")
        sys.exit(1)

    if not json_mode:
        print("\n✅ Login OAuth concluído!")

    return session


def apply_tokens(session: "tidalapi.Session"):
    """Extrai tokens da sessão e os grava no config.toml + backup."""
    user_id = session.user.id if session.user else ""
    country_code = session.country_code or "BR"
    access_token = session.access_token or ""
    refresh_token = session.refresh_token or ""

    # Grava o expiry real da sessão (streamrip >= 2.2.0 corrigiu o client_id de
    # refresh, então não precisamos mais mentir a expiração pra forçar o
    # streamrip a usar o access_token direto).
    expiry = int(session.expiry_time.timestamp()) if session.expiry_time else int(time.time()) + 3600

    print()
    print("─" * 60)
    print(f"  user_id       : {user_id}")
    print(f"  country_code  : {country_code}")
    print(f"  token_expiry  : {expiry}  ({time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(expiry))})")
    print(f"  access_token  : {access_token[:40]}…")
    print("─" * 60)
    print()

    write_tokens_to_config(user_id, country_code, access_token, refresh_token, expiry)
    save_backup(user_id, country_code, access_token, refresh_token, expiry)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    force_oauth = "--force" in args
    check_only  = "--check" in args
    json_mode   = "--json"  in args

    if not json_mode:
        print("=" * 60)
        print("  TideCaller — Gerenciamento de Tokens Tidal")
        print("=" * 60)
        print()

    # Modo --check: verifica via API (não só o timestamp)
    if check_only:
        try:
            import tidalapi
            from datetime import datetime, timezone
            content = CONFIG_TOML.read_text(encoding="utf-8") if CONFIG_TOML.exists() else ""

            def _extract(key):
                m = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]*)"', content, re.MULTILINE)
                if m: return m.group(1)
                m = re.search(rf'^{re.escape(key)}\s*=\s*(\S+)', content, re.MULTILINE)
                return m.group(1) if m else ""

            access_token  = _extract("access_token")
            refresh_token = _extract("refresh_token")
            token_expiry  = _extract("token_expiry")

            if not access_token or not refresh_token:
                print("❌ Nenhum token encontrado no config.")
                sys.exit(1)

            session = tidalapi.Session()
            expiry_dt = datetime.fromtimestamp(int(token_expiry or 0), tz=timezone.utc) if token_expiry else None
            session.load_oauth_session("Bearer", access_token, refresh_token, expiry_dt)
            if session.check_login():
                print("✅ Token válido (verificado via API Tidal).")
                sys.exit(0)
            else:
                print("❌ Token inválido (check_login() retornou False).")
                sys.exit(1)
        except Exception as e:
            print(f"❌ Erro ao verificar token: {e}")
            sys.exit(1)

    # Verificar expiração
    expired = is_token_expired()

    if not force_oauth and not expired:
        if not json_mode:
            print("ℹ️  Token ainda válido. Use --force para forçar novo login OAuth.")
        else:
            json_emit({"type": "done", "refreshed": False})
        sys.exit(0)

    # Tentar refresh automático sem login (se não for --force)
    session = None
    if not force_oauth:
        session = load_session_from_config()

    # Fallback: login OAuth interativo
    if session is None:
        session = oauth_login(json_mode=json_mode)

    apply_tokens(session)

    if json_mode:
        json_emit({"type": "done", "refreshed": True})
    else:
        print()
        print("🎵 Pronto! streamrip já pode usar os novos tokens.")
        print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  Cancelado pelo usuário.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Erro inesperado: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
