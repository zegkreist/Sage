# ────────────────────────────────────────────────────────────────
# Stage 1 — Build Svelte frontend
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app/frontend

# Install deps first (cache layer)
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ ./
RUN npm run build


# ────────────────────────────────────────────────────────────────
# Stage 2 — Production server
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS prod

# System deps for audio analysis (ffmpeg, python3 for essentia scripts)
RUN apk add --no-cache ffmpeg python3 py3-pip bash

WORKDIR /app

# Install production Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Overwrite public/ with the Vite build output
COPY --from=builder /app/frontend/dist ./public

# Non-root user for security
RUN addgroup -S musicsage && adduser -S musicsage -G musicsage \
    && chown -R musicsage:musicsage /app
USER musicsage

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/api/health || exit 1

CMD ["node", "index.js"]
