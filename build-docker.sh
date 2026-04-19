#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# build-docker.sh — constrói a imagem Docker do MusicSage
#
# Uso:
#   ./build-docker.sh              # tag padrão: musicsage:latest
#   ./build-docker.sh --tag v1.2.3 # tag customizada
#   ./build-docker.sh --push       # faz push para registry após o build
#   ./build-docker.sh --no-cache   # força rebuild sem cache
#
# O script deve ser executado a partir da raiz do monorepo (plex_server/)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUSICSAGE_DIR="$SCRIPT_DIR/agents/MusicSage"

# ── Defaults ─────────────────────────────────────────────────────────────────
IMAGE_NAME="musicsage"
TAG="latest"
PUSH=false
NO_CACHE=""

# ── Argparse ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)     TAG="$2";     shift 2 ;;
    --name)    IMAGE_NAME="$2"; shift 2 ;;
    --push)    PUSH=true;    shift ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help)
      grep "^#" "$0" | sed 's/^# \{0,2\}//'
      exit 0 ;;
    *) echo "Opção desconhecida: $1"; exit 1 ;;
  esac
done

FULL_TAG="${IMAGE_NAME}:${TAG}"

echo "══════════════════════════════════════════════"
echo "  MusicSage Docker Build"
echo "  Imagem: $FULL_TAG"
echo "  Contexto: $MUSICSAGE_DIR"
echo "══════════════════════════════════════════════"

# ── Verifica pré-requisitos ───────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "❌ Docker não encontrado. Instale o Docker e tente novamente."
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────────────────
echo ""
echo "▶ Construindo imagem..."
docker build \
  $NO_CACHE \
  --tag "$FULL_TAG" \
  --file "$MUSICSAGE_DIR/Dockerfile" \
  "$MUSICSAGE_DIR"

echo ""
echo "✅ Imagem construída: $FULL_TAG"
echo "   Tamanho: $(docker image inspect $FULL_TAG --format='{{.Size}}' | awk '{printf "%.1f MB", $1/1024/1024}')"

# ── Push opcional ─────────────────────────────────────────────────────────────
if [[ "$PUSH" == "true" ]]; then
  echo ""
  echo "▶ Fazendo push para o registry..."
  docker push "$FULL_TAG"
  echo "✅ Push concluído: $FULL_TAG"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  Para rodar o container:"
echo ""
echo "  docker run -d \\"
echo "    --name musicsage \\"
echo "    -p 3002:3002 \\"
echo "    --env-file agents/MusicSage/.env \\"
echo "    -v \$(pwd)/music:/music:ro \\"
echo "    -v \$(pwd)/mediasage:/app/mediasage \\"
echo "    $FULL_TAG"
echo "══════════════════════════════════════════════"
