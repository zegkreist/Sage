/**
 * LyricsService
 *
 * Busca letras via LRCLIB (https://lrclib.net) e as salva junto ao arquivo
 * de áudio no formato esperado pelo Plex para letras locais:
 *
 *   .lrc — letras sincronizadas (timestamps [mm:ss.xx] por linha)
 *   .txt — letras simples (fallback quando não há versão sincronizada)
 *
 * O arquivo deve ter o mesmo nome do arquivo de áudio, apenas com extensão
 * diferente, e deve estar na mesma pasta.
 * Ex: /music/Artist/Album/01 - Track.flac → /music/Artist/Album/01 - Track.lrc
 */

import { existsSync, writeFileSync } from "fs";
import { dirname, basename, extname, join } from "path";
import { logger } from "../logger.js";

const LRCLIB_URL    = "https://lrclib.net/api/get";
const FETCH_TIMEOUT = 20_000;

// Normaliza strings para o LRCLIB: converte aspa tipográficas, hífens especiais
// e outros caracteres Unicode que os metadados do Plex podem conter mas que o
// LRCLIB não indexa nessa forma.
function normalize(str) {
  return (str ?? "")
    .replace(/[‘’‚‛ʼ]/g, "'")       // aspas simples → '
    .replace(/[“”„‟]/g,        '"')       // aspas duplas  → "
    .replace(/[‐‑‒–—―]/g, "-") // hífens/dashes → -
    .replace(/·/g, "·")                                  // middle dot
    .trim();
}

export class LyricsService {
  /**
   * @param {{ audioAnalyzer?: import('./AudioAnalyzerService.js').AudioAnalyzerService }} config
   */
  constructor({ audioAnalyzer } = {}) {
    this._audioAnalyzer = audioAnalyzer;
  }

  // ─── API pública ──────────────────────────────────────────────────────────

  /**
   * Converte um path do Plex para path local no filesystem.
   * Delega ao AudioAnalyzerService se disponível.
   */
  resolvePath(plexPath) {
    return this._audioAnalyzer ? this._audioAnalyzer._resolvePath(plexPath) : plexPath;
  }

  /**
   * Retorna o path do arquivo de letras existente (.lrc preferido, .txt fallback),
   * ou null se nenhum existir.
   */
  existingLyricsPath(audioFilePath) {
    const lrc = this._lrcPath(audioFilePath);
    if (existsSync(lrc)) return lrc;
    const txt = this._txtPath(audioFilePath);
    if (existsSync(txt)) return txt;
    return null;
  }

  /** Retorna true se já existe um arquivo de letras junto ao áudio. */
  hasLyrics(audioFilePath) {
    return this.existingLyricsPath(audioFilePath) !== null;
  }

  /**
   * Busca letras no LRCLIB para uma faixa.
   * Estratégia em cascata:
   *   1. title + artist + album + duration  (match exato)
   *   2. title + artist + duration          (sem album — álbuns de compilação)
   *   3. title + artist                     (sem duration — versões alternativas)
   *
   * @param {{ title: string, artist: string, album?: string, duration?: number }} track
   * @returns {Promise<{ syncedLyrics: string|null, plainLyrics: string|null }|null>}
   */
  async fetchLyrics({ title, artist, album, duration }) {
    if (!title || !artist) return null;

    const t = normalize(title);
    const a = normalize(artist);
    const al = normalize(album);
    const dur = duration ? Math.round(duration) : null;

    // Tentativa 1: com album + duration
    let result = await this._fetchOne(t, a, al || null, dur);
    if (result) return result;

    // Tentativa 2: sem album (compilações ou álbuns com nome diferente no LRCLIB)
    if (al) {
      result = await this._fetchOne(t, a, null, dur);
      if (result) return result;
    }

    // Tentativa 3: sem duration (versões ao vivo, remixes, etc.)
    if (dur) {
      result = await this._fetchOne(t, a, null, null);
      if (result) return result;
    }

    return null;
  }

  // ─── Privado: uma única chamada ao LRCLIB ─────────────────────────────────

  async _fetchOne(title, artist, album, duration) {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album)    params.set("album_name", album);
    if (duration) params.set("duration", String(duration));

    const url = `${LRCLIB_URL}?${params}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 404) return null;
      if (!res.ok) {
        logger.warn("LYRICS", `LRCLIB retornou ${res.status} para "${artist} – ${title}"`);
        return null;
      }

      const data = await res.json();
      const syncedLyrics = data.syncedLyrics || null;
      const plainLyrics  = data.plainLyrics  || null;

      if (!syncedLyrics && !plainLyrics) return null;
      return { syncedLyrics, plainLyrics };
    } catch (err) {
      if (err.name === "AbortError") {
        logger.warn("LYRICS", `Timeout buscando letras: "${artist} – ${title}"`);
      } else {
        logger.warn("LYRICS", `Erro ao buscar letras para "${artist} – ${title}": ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Salva letras em disco ao lado do arquivo de áudio.
   * Prefere .lrc (sincronizado); usa .txt como fallback.
   *
   * @param {string} audioFilePath — path local do arquivo de áudio
   * @param {{ syncedLyrics: string|null, plainLyrics: string|null }} lyrics
   * @returns {string|null} Path do arquivo salvo, ou null se sem conteúdo
   */
  saveLyrics(audioFilePath, { syncedLyrics, plainLyrics }) {
    if (syncedLyrics) {
      const lrcPath = this._lrcPath(audioFilePath);
      writeFileSync(lrcPath, syncedLyrics, "utf8");
      return lrcPath;
    }
    if (plainLyrics) {
      const txtPath = this._txtPath(audioFilePath);
      writeFileSync(txtPath, plainLyrics, "utf8");
      return txtPath;
    }
    return null;
  }

  // ─── Privado ──────────────────────────────────────────────────────────────

  _lrcPath(audioFilePath) {
    return join(dirname(audioFilePath), basename(audioFilePath, extname(audioFilePath)) + ".lrc");
  }

  _txtPath(audioFilePath) {
    return join(dirname(audioFilePath), basename(audioFilePath, extname(audioFilePath)) + ".txt");
  }
}
