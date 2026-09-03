#!/usr/bin/env bash
#
# token_guard.sh — Executa um comando streamrip com retry automático de token
#
# Uso (source não necessário — use diretamente):
#   token_guard <rip_bin> [args...]
#
# Comportamento:
#   1. Executa o comando normalmente
#   2. Se falhar com saída indicando erro de autenticação (401 / token inválido),
#      dispara refresh_token.sh automaticamente e tenta de novo (uma vez)
#   3. Se o refresh também falhar, encerra com código de erro
#
# Padrões de falha de autenticação reconhecidos no output do streamrip:
#   - "401"  (HTTP Unauthorized)
#   - "Unauthorized"
#   - "token" + "invalid/expired/refresh"
#   - "login" / "not logged in"
#   - "TidalAuthError" / "AuthorizationError"
#   - "OAuth"
#

_TOKEN_GUARD_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TOKEN_GUARD_AGENT_DIR="$(dirname "$_TOKEN_GUARD_SETUP_DIR")"
_REFRESH_SCRIPT="$_TOKEN_GUARD_AGENT_DIR/scripts/refresh_token.sh"

_is_auth_error() {
  local output="$1"
  echo "$output" | grep -qiE \
    '401|Unauthorized|TidalAuthError|AuthorizationError|not logged in|OAuth|token.*(invalid|expired)|invalid.*token|login required|SessionExpired'
}

token_guard() {
  local tmp
  tmp="$(mktemp)"

  # Primeira tentativa — captura stdout+stderr para detectar erros de auth
  # mas ainda replica o output para o terminal em tempo real
  "$@" 2>&1 | tee "$tmp"
  local exit_code="${PIPESTATUS[0]}"

  if [[ "$exit_code" -eq 0 ]]; then
    rm -f "$tmp"
    return 0
  fi

  local captured
  captured="$(cat "$tmp")"
  rm -f "$tmp"

  # Verificar se é um erro de autenticação
  if ! _is_auth_error "$captured"; then
    # Falha por outro motivo — repassa o código de saída
    return "$exit_code"
  fi

  # ── É um erro de auth: tentar renovar o token ────────────────────────────
  echo ""
  echo "┌──────────────────────────────────────────────────────────┐"
  echo "│  🔐  Token Tidal inválido ou expirado detectado          │"
  echo "│      Iniciando renovação automática...                   │"
  echo "└──────────────────────────────────────────────────────────┘"
  echo ""

  if [[ ! -f "$_REFRESH_SCRIPT" ]]; then
    echo "❌  refresh_token.sh não encontrado em: $_REFRESH_SCRIPT"
    return 1
  fi

  # Tenta primeiro um refresh silencioso (reusa refresh_token, sem interação).
  # Só cai para --force (OAuth interativo) se isso também falhar.
  bash "$_REFRESH_SCRIPT"
  local refresh_code=$?

  if [[ "$refresh_code" -ne 0 ]]; then
    echo ""
    echo "🔐  Refresh silencioso falhou — tentando login OAuth completo..."
    bash "$_REFRESH_SCRIPT" --force
    refresh_code=$?
  fi

  if [[ "$refresh_code" -ne 0 ]]; then
    echo ""
    echo "❌  Renovação de token falhou (código $refresh_code)."
    echo "    Execute manualmente: node plex-cli.js tidecaller:refresh-token"
    return 1
  fi

  # ── Segunda tentativa após refresh ───────────────────────────────────────
  echo ""
  echo "🔄  Retomando download após renovação de token..."
  echo ""

  "$@"
  return $?
}
