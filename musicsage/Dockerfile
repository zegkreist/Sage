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
FROM node:20-slim AS frontend-builder

WORKDIR /build/frontend
COPY musicsage/frontend/package*.json ./
RUN npm ci
COPY musicsage/frontend/ ./
RUN npm run build


# ─── Stage 2 — Instala deps Node dos agents ──────────────────────────────────
FROM node:20-slim AS agents-builder

# AllFather e Transporter primeiro (mudam raramente)
COPY agents/AllFather/   /agents/AllFather/
COPY agents/Transporter/ /agents/Transporter/
RUN cd /agents/AllFather && npm install --omit=dev
RUN cd /agents/Transporter && npm install --omit=dev

# Stormbringer por último (muda com frequência)
COPY agents/Stormbringer/ /agents/Stormbringer/
RUN cd /agents/Stormbringer && \
    node -e " \
      const fs = require('fs'); \
      const p  = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
      p.dependencies['@plex-agents/transporter'] = 'file:../Transporter'; \
      fs.writeFileSync('package.json', JSON.stringify(p, null, 2)); \
    " && \
    npm install --omit=dev


# ─── Stage 3 — Production server ─────────────────────────────────────────────
FROM node:20-slim AS prod

# 1. Sistema: ffmpeg, bash, Python (lento, estável)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        python3-venv \
        gcc \
        python3-dev \
        libffi-dev \
        libssl-dev \
        cargo \
        curl \
    && pip3 install --no-cache-dir --break-system-packages \
        tidalapi \
        streamrip \
    && sed -i 's/except TypeError as e:/except Exception as e:/' \
        $(python3 -c "import site; print(site.getsitepackages()[0])")/streamrip/client/tidal.py \
    && apt-get remove -y gcc python3-dev libffi-dev libssl-dev cargo \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip /root/.cargo

# 2. Venv do TideCaller (lento, estável — não depende de nenhum source copiado)
RUN python3 -m venv /agents/TideCaller/.venv_tidal \
    && /agents/TideCaller/.venv_tidal/bin/pip install --no-cache-dir tidalapi streamrip
# Patch: lyrics 401 não deve abortar o download (streamrip issue #959).
RUN sed -i 's/except TypeError as e:/except Exception as e:/' \
    /agents/TideCaller/.venv_tidal/lib/python3.*/site-packages/streamrip/client/tidal.py

# 3. Agents estáveis (mudam raramente)
COPY --from=agents-builder /agents/AllFather    /agents/AllFather
COPY --from=agents-builder /agents/Transporter  /agents/Transporter

# 4. MusicSage deps Node (só re-roda quando package.json mudar)
WORKDIR /app
COPY musicsage/package*.json ./
RUN npm install --omit=dev && \
    rm -rf node_modules/@plex-agents/allfather && \
    ln -s /agents/AllFather node_modules/@plex-agents/allfather

# 5. MusicSage source + frontend compilado
COPY musicsage/ .
COPY --from=frontend-builder /build/frontend/dist ./public

# 6. Agents que mudam com frequência (Stormbringer, TideCaller scripts)
COPY --from=agents-builder /agents/Stormbringer /agents/Stormbringer
COPY agents/TideCaller/scripts  /agents/TideCaller/scripts
COPY agents/TideCaller/setup    /agents/TideCaller/setup
COPY agents/TideCaller/config   /agents/TideCaller/config
# Atenção: o token OAuth do Tidal fica em /agents/TideCaller/config/.config
# Monte um volume ou passe via env para persistência: -v tidal-config:/agents/TideCaller/config

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
  CMD curl -sf http://localhost:3002/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
