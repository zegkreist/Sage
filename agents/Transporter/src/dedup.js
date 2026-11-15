import fs from "fs";
import path from "path";
import { normalizeForComparison, calculateSimilarity } from "./strings.js";

/**
 * Procura pasta de álbum compatível já existente para deduplicação.
 *
 * Estratégia (em ordem de prioridade):
 *  1. Verifica `processedAlbums` da sessão atual (by normalized artist + fuzzy album name)
 *  2. Verifica subpastas físicas em `artistDir` (fuzzy name match ≥ 0.85)
 *
 * @param {string} artist - Nome do artista
 * @param {string} album  - Nome do álbum (pode conter tags de qualidade)
 * @param {string} artistDir - Caminho do diretório do artista no destino
 * @param {Map}    processedAlbums - Álbuns criados nesta sessão: key → { artist, albumName, path }
 * @returns {string|null} Caminho da pasta existente, ou null se não encontrado
 */
export function findExistingAlbumDir(artist, album, artistDir, processedAlbums) {
  const normalizedArtist = normalizeForComparison(artist);
  const normalizedAlbum = normalizeForComparison(album);

  // 1. Álbuns já processados nesta sessão
  for (const [, info] of processedAlbums) {
    if (normalizeForComparison(info.artist) !== normalizedArtist) continue;
    const sim = calculateSimilarity(normalizedAlbum, normalizeForComparison(info.albumName));
    if (sim >= 0.85) return info.path;
  }

  // 2. Pastas físicas no diretório do artista
  if (!fs.existsSync(artistDir)) return null;
  for (const sub of fs.readdirSync(artistDir)) {
    const subPath = path.join(artistDir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    const sim = calculateSimilarity(normalizedAlbum, normalizeForComparison(sub));
    if (sim >= 0.85) return subPath;
  }

  return null;
}

/**
 * Procura pasta de série (show) já existente no destino com nome equivalente.
 *
 * Episódios do mesmo show chegam com grafias levemente diferentes
 * ("Show Name", "Show.Name.2020", "Show Name (2020) 1080p") — sem fuzzy,
 * cada grafia viraria uma pasta separada na biblioteca.
 *
 * Estratégia:
 *  1. Normaliza ambos os lados (remove acentos/ano/artefatos) e compara
 *     igualdade exata — cobre a maioria dos casos baratos.
 *  2. Similaridade fuzzy ≥ 0.9 (limiar mais alto que álbuns: nomes de
 *     série são curtos e colidem fácil — ex "Friends" vs "Frends" não
 *     passa, mas "The Office US" vs "The Office" passa).
 *
 * @param {string} showName  - Nome parseado do episódio
 * @param {string} seriesDir - Raiz das séries no destino (ex: /media/tv)
 * @param {number} [threshold=0.9]
 * @returns {string|null} Caminho da pasta existente, ou null
 */
export function findExistingShowDir(showName, seriesDir, threshold = 0.9) {
  const normalizedShow = normalizeForComparison(showName)
    // Ano solto no fim ("Breaking Bad 2014", grafias de release sem parênteses)
    .replace(/\d{4}$/, "");
  if (!normalizedShow || !fs.existsSync(seriesDir)) return null;

  for (const sub of fs.readdirSync(seriesDir)) {
    const subPath = path.join(seriesDir, sub);
    try {
      if (!fs.statSync(subPath).isDirectory()) continue;
    } catch { continue; }

    const normalizedSub = normalizeForComparison(sub).replace(/\d{4}$/, "");
    if (normalizedSub === normalizedShow) return subPath;

    const sim = calculateSimilarity(normalizedShow, normalizedSub);
    if (sim >= threshold) return subPath;
  }

  return null;
}
