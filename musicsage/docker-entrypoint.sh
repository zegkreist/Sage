#!/bin/sh
# docker-entrypoint.sh — extrai PLEX_TOKEN, inicia Node com forwarding de sinal e log de crash

# ── Helpers de log (formato idêntico ao logger.js da app) ─────────────────
# Saída: "YYYY-MM-DD HH:MM:SS.000 [LEVEL] [ENTRYPOINT] mensagem"
# Grava no mesmo arquivo diário que a aplicação usa.
LOG_DIR="${LOG_DIR:-/data/logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || true

_log() {
  _level="$1"; _msg="$2"
  _ts=$(date -u +"%Y-%m-%d %H:%M:%S.000")
  _line="$_ts [$_level] [ENTRYPOINT] $_msg"
  printf '%s\n' "$_line"                                           # stdout → docker logs
  printf '%s\n' "$_line" >> "$LOG_DIR/musicsage-$(date -u +%Y-%m-%d).log" 2>/dev/null || true
}

# ── Extrai PLEX_TOKEN do Preferences.xml se não fornecido via env ──────────
if [ -z "$PLEX_TOKEN" ] && [ -n "$PLEX_CONFIG_DIR" ]; then
  PREFS="$PLEX_CONFIG_DIR/Library/Application Support/Plex Media Server/Preferences.xml"
  if [ -f "$PREFS" ]; then
    # sed funciona no BusyBox (Alpine) — grep -P não funciona
    TOKEN=$(sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' "$PREFS" | head -1)
    if [ -n "$TOKEN" ]; then
      export PLEX_TOKEN="$TOKEN"
      _log "INFO " "PLEX_TOKEN extraído do Preferences.xml"
    else
      _log "WARN " "PlexOnlineToken não encontrado em $PREFS"
    fi
  else
    _log "WARN " "Preferences.xml não encontrado em: $PREFS"
  fi
elif [ -n "$PLEX_TOKEN" ]; then
  _log "INFO " "PLEX_TOKEN recebido via variável de ambiente"
else
  _log "WARN " "PLEX_TOKEN e PLEX_CONFIG_DIR não definidos — Plex pode rejeitar requests"
fi

# ── Inicia Node.js ─────────────────────────────────────────────────────────
# Não usamos "exec" para podermos capturar o exit code e propagar sinais.
# O shell (PID 1) receive SIGTERM/SIGINT do Docker e encaminha ao Node.
_log "INFO " "Iniciando node index.js"

# ── Garante diretórios de runtime dentro dos volumes ──────────────────────
# Os volumes são bind mounts; as pastas criadas no build não existem no host.
# Se o host não as criou, o streamrip/torrent falha ao tentar escrever.
mkdir -p \
  "${DOWNLOADS_DIR:-/downloads}/tidecaller" \
  "${DOWNLOADS_DIR:-/downloads}/stormbringer/musicas" \
  "${DOWNLOADS_DIR:-/downloads}/stormbringer/filmes" \
  "${DOWNLOADS_DIR:-/downloads}/stormbringer/series" \
  "${DATA_DIR:-/data}/streamrip" \
  "${DATA_DIR:-/data}/stormbringer" \
  "${DATA_DIR:-/data}/logs" \
  "${DATA_DIR:-/data}/embeddings" \
  "${DATA_DIR:-/data}/playlists" \
  2>/dev/null || true
_log "INFO " "Diretórios de runtime verificados"
node index.js &
NODE_PID=$!

trap 'kill -TERM "$NODE_PID" 2>/dev/null' TERM
trap 'kill -INT  "$NODE_PID" 2>/dev/null' INT

wait "$NODE_PID"
EXIT_CODE=$?

# ── Avalia saída ───────────────────────────────────────────────────────────
# 0   = saída limpa (inclusive graceful shutdown via process.exit(0))
# 130 = SIGINT  (Ctrl+C)
# 143 = SIGTERM (docker stop → node respondeu com exit 0; este código indica
#                que o Node foi morto externamente sem handler, não esperado)
# 137 = SIGKILL (docker kill ou OOM killer)
if [ "$EXIT_CODE" -eq 0 ]; then
  _log "INFO " "Node encerrado normalmente (código 0)"
elif [ "$EXIT_CODE" -eq 130 ] || [ "$EXIT_CODE" -eq 143 ]; then
  _log "INFO " "Node encerrado por sinal do sistema (código $EXIT_CODE)"
elif [ "$EXIT_CODE" -eq 137 ]; then
  _log "ERROR" "Node morto por SIGKILL (código 137) — possível timeout no graceful shutdown ou OOM. Verifique os logs acima e a memória disponível."
else
  _log "ERROR" "Node encerrou inesperadamente com código $EXIT_CODE — verifique os logs acima para detalhes do erro."
fi

exit "$EXIT_CODE"
