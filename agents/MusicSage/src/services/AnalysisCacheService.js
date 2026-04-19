/**
 * AnalysisCacheService
 *
 * Armazena análises de áudio (AudioAnalysis) geradas pelo MusicAnalyzer em disco.
 * Permite que playlists por áudio usem dados pré-analisados em vez de chamar
 * o Ollama a cada solicitação.
 *
 * Arquivo em disco: mediasage/analysis-cache.json
 * Formato:
 * {
 *   "version": 1,
 *   "updatedAt": "2026-04-15T…",
 *   "tracks": {
 *     "<ratingKey>": {
 *       "ratingKey": "12345",
 *       "title": "Black Dog",
 *       "artist": "Led Zeppelin",
 *       "album": "Led Zeppelin IV",
 *       "filePath": "/music/…/track.flac",
 *       "analysis": { genre, subgenre, mood, … },
 *       "analyzedAt": "2026-04-15T…"
 *     }
 *   }
 * }
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync }                  from "fs";
import { join, dirname }               from "path";
import { fileURLToPath }               from "url";
import { logger }                       from "../logger.js";

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE  = join(__dirname, "../../../../mediasage/analysis-cache.json");
const CACHE_DIR   = dirname(CACHE_FILE);
const CACHE_VERSION = 1;

export class AnalysisCacheService {
  constructor() {
    /** @type {Map<string, object>} ratingKey → { ratingKey, title, artist, album, filePath, analysis, analyzedAt } */
    this._cache   = new Map();
    this._dirty   = false;
    this._writing = false;
    this._loaded  = false;
  }

  // ─── API pública ──────────────────────────────────────────────────────────

  /** Carrega o cache do disco. Deve ser chamado 1x antes de usar. */
  async load() {
    if (this._loaded) return;
    try {
      if (!existsSync(CACHE_FILE)) {
        this._loaded = true;
        return;
      }
      const raw  = await readFile(CACHE_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (data?.tracks && typeof data.tracks === "object") {
        for (const [key, value] of Object.entries(data.tracks)) {
          this._cache.set(String(key), value);
        }
      }
      logger.info("ANALYSIS_CACHE", `Carregado — ${this._cache.size} faixas analisadas`);
    } catch (err) {
      logger.warn("ANALYSIS_CACHE", `Falha ao carregar cache: ${err.message}`);
    }
    this._loaded = true;
  }

  /**
   * Retorna a análise de uma faixa, ou null se não estiver no cache.
   * @param {string} ratingKey
   * @returns {object|null}
   */
  get(ratingKey) {
    return this._cache.get(String(ratingKey)) ?? null;
  }

  /**
   * Retorna apenas a parte `analysis` de uma faixa, ou null.
   * @param {string} ratingKey
   * @returns {object|null}
   */
  getAnalysis(ratingKey) {
    return this._cache.get(String(ratingKey))?.analysis ?? null;
  }

  /** @returns {boolean} */
  has(ratingKey) {
    return this._cache.has(String(ratingKey));
  }

  /**
   * Salva (ou atualiza) a análise de uma faixa no cache.
   * @param {string} ratingKey
   * @param {object} trackMeta  — { title, artist, album, filePath }
   * @param {object} analysis   — resultado de MusicAnalyzer.analyzeAudioFile()
   */
  set(ratingKey, trackMeta, analysis) {
    this._cache.set(String(ratingKey), {
      ratingKey:  String(ratingKey),
      title:      trackMeta.title   || "Unknown",
      artist:     trackMeta.artist  || "Unknown",
      album:      trackMeta.album   || "Unknown",
      filePath:   trackMeta.filePath || "",
      analysis,
      analyzedAt: new Date().toISOString(),
    });
    this._dirty = true;
    this._scheduleSave();
  }

  /** Retorna todos os registros como array. */
  getAll() {
    return [...this._cache.values()];
  }

  /** Total de faixas analisadas. */
  size() {
    return this._cache.size;
  }

  /** Serialização para resposta HTTP. */
  toJSON() {
    return {
      version:   CACHE_VERSION,
      size:      this._cache.size,
      updatedAt: new Date().toISOString(),
      tracks:    Object.fromEntries(this._cache),
    };
  }

  /** Força escrita imediata ao disco. */
  async flush() {
    if (!this._dirty) return;
    await this._writeToDisk();
  }

  /** Limpa todo o cache em memória e persiste o arquivo vazio ao disco. */
  async clear() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._cache.clear();
    this._dirty = true;
    await this._writeToDisk();
    logger.info("ANALYSIS_CACHE", "Cache limpo");
  }

  // ─── Privado ──────────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._writeToDisk(), 3_000);
  }

  async _writeToDisk() {
    if (this._writing) return;
    this._writing = true;
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      const data = {
        version:   CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        tracks:    Object.fromEntries(this._cache),
      };
      await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
      this._dirty = false;
      logger.debug("ANALYSIS_CACHE", `Cache salvo — ${this._cache.size} faixas`);
    } catch (err) {
      logger.error("ANALYSIS_CACHE", `Falha ao salvar cache: ${err.message}`);
    } finally {
      this._writing = false;
    }
  }
}
