# ──────────────────────────────────────────────────────────────────────────────
# MusicSage — Multi-stage Docker build
#
# IMPORTANTE: construir a partir da RAIZ de plex_server/:
#
#   cd plex_server/
#   docker build -f musicsage/Dockerfile -t musicsage:latest .
#
# Todos os agents (AllFather, Stormbringer, TideCaller, Transporter) são
# copiados para dentro da imagem — sem dependência de volumes externos.
#
# Volumes obrigatórios:
#   /data              — persistência (cache, embeddings, playlists, logs)
#   /media/music       — arquivos de música (share do NAS ou pasta local)
#   /downloads         — pasta de downloads dos agentes (Stormbringer + TideCaller)
# ──────────────────────────────────────────────────────────────────────────────


# ─── Stage 1 — Build Svelte frontend ─────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend
COPY musicsage/frontend/package*.json ./
RUN npm ci
COPY musicsage/frontend/ ./
RUN npm run build


# ─── Stage 2 — Instala deps Node dos agents ──────────────────────────────────
FROM node:20-alpine AS agents-builder

# Copia todo o source primeiro — necessário para que Stormbringer possa
# referenciar Transporter como file: dep local durante o npm install.
COPY agents/AllFather/   /agents/AllFather/
COPY agents/Stormbringer/ /agents/Stormbringer/
COPY agents/Transporter/  /agents/Transporter/

# AllFather — sem deps locais
RUN cd /agents/AllFather && npm install --omit=dev

# Transporter — sem deps locais
RUN cd /agents/Transporter && npm install --omit=dev

# Stormbringer — depende de @plex-agents/transporter como pacote local.
# O package.json usa "*" (sem file:), então patchamos para file: antes do install.
RUN cd /agents/Stormbringer && \
    node -e " \
      const fs = require('fs'); \
      const p  = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
      p.dependencies['@plex-agents/transporter'] = 'file:../Transporter'; \
      fs.writeFileSync('package.json', JSON.stringify(p, null, 2)); \
    " && \
    npm install --omit=dev


# ─── Stage 3 — Production server ─────────────────────────────────────────────
FROM node:20-alpine AS prod

# Sistema: ffmpeg, bash, Python com dependências de compilação para streamrip
RUN apk add --no-cache \
        ffmpeg \
        bash \
        python3 \
        py3-pip \
        gcc \
        musl-dev \
        python3-dev \
        libffi-dev \
        openssl-dev \
        cargo \
        rust \
    && pip3 install --no-cache-dir --break-system-packages \
        tidalapi \
        streamrip \
    && apk del gcc musl-dev python3-dev libffi-dev openssl-dev cargo rust \
    && rm -rf /root/.cache/pip /root/.cargo

# ── Agents já com deps instaladas ────────────────────────────────────────────
COPY --from=agents-builder /agents/AllFather    /agents/AllFather
COPY --from=agents-builder /agents/Stormbringer /agents/Stormbringer
COPY --from=agents-builder /agents/Transporter  /agents/Transporter

# TideCaller: scripts Python, setup e config
COPY agents/TideCaller/scripts  /agents/TideCaller/scripts
COPY agents/TideCaller/setup    /agents/TideCaller/setup
COPY agents/TideCaller/config   /agents/TideCaller/config
# Cria o venv do TideCaller e instala dependências nele.
# Isso garante que TC_PYTHON (.venv_tidal/bin/python3) exista no container.
RUN python3 -m venv /agents/TideCaller/.venv_tidal \
    && /agents/TideCaller/.venv_tidal/bin/pip install --no-cache-dir tidalapi streamrip
# Atenção: o token OAuth do Tidal fica em /agents/TideCaller/config/.config
# Monte um volume ou passe via env para persistência: -v tidal-config:/agents/TideCaller/config

# ── MusicSage ────────────────────────────────────────────────────────────────
WORKDIR /app

# AllFather precisa estar resolvível como file: dep. Cria link simbólico
# para /agents/AllFather que o npm já resolveu no stage anterior.
COPY musicsage/package*.json ./
# Injeta AllFather no node_modules diretamente (evita file: dep quebrada)
RUN npm install --omit=dev && \
    rm -rf node_modules/@plex-agents/allfather && \
    ln -s /agents/AllFather node_modules/@plex-agents/allfather

COPY musicsage/ .

# Build do frontend já compilado
COPY --from=frontend-builder /build/frontend/dist ./public

# ── Aponta downloads do Stormbringer para o volume /downloads ─────────────────
# Remove o diretório downloads/ copiado (está vazio ou tem subpastas vazias)
# e cria um symlink para /downloads/stormbringer (que é o volume montável).
# Em runtime o Docker monta o volume e o symlink resolve corretamente.
RUN rm -rf /agents/Stormbringer/downloads \
    && ln -s /downloads/stormbringer /agents/Stormbringer/downloads \
    && mkdir -p /downloads/stormbringer/musicas \
                /downloads/stormbringer/filmes \
                /downloads/stormbringer/series \
                /downloads/tidecaller \
                /data/logs /data/embeddings /data/playlists /data/streamrip \
                /media/music /media/movies /media/series

# ─── Entrypoint ───────────────────────────────────────────────────────────────
# Lê PLEX_TOKEN do Preferences.xml (via PLEX_CONFIG_DIR) se não passado via env.
COPY musicsage/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# ─── Variáveis de ambiente ────────────────────────────────────────────────────
# Não inclua secrets (PLEX_TOKEN, LASTFM_API_KEY) aqui — passe via --env-file ou -e em runtime.
ENV MUSICSAGE_PORT=3002 \
    NODE_ENV=production \
    PLEX_URL=http://localhost:32400 \
    OLLAMA_URL=http://localhost:11434 \
    OLLAMA_DEFAULT_MODEL=gemma4:e4b \
    EMBEDDING_MODEL=nomic-embed-text \
    PLEX_MEDIA_PATH=/media \
    DATA_DIR=/data \
    LOG_DIR=/data/logs \
    STORMBRINGER_DIR=/agents/Stormbringer \
    TIDECALLER_DIR=/agents/TideCaller \
    TRANSPORTER_DIR=/agents/Transporter \
    XDG_CONFIG_HOME=/agents/TideCaller/config/.config

# ─── Volumes ──────────────────────────────────────────────────────────────────
# /data      — análises, embeddings, playlists, logs
# /media/music — biblioteca de músicas (read-only recomendado)
# /downloads — downloads do Stormbringer (musicas/ filmes/ series/) e TideCaller
VOLUME ["/data", "/media", "/downloads"]

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3002/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
