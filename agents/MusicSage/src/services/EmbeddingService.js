/**
 * EmbeddingService
 *
 * Gera vetores semânticos para cada faixa da biblioteca usando:
 * 1. Descrição textual baseada nos metadados (título, artista, álbum, gêneros)
 * 2. Modelo de embedding do Ollama (padrão: nomic-embed-text, 768 dimensões)
 *
 * Os vetores são persistidos em mediasage/embeddings/track-embeddings.json.
 * Faixas já processadas são ignoradas no re-processamento (cache por ratingKey).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";
import { buildGenreContext } from "../genreVocabulary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS_DIR  = join(__dirname, "../../../../mediasage/embeddings");
const EMBEDDINGS_FILE = join(EMBEDDINGS_DIR, "track-embeddings.json");

const BATCH_DELAY_MS = 50; // pausa entre faixas para não sobrecarregar Ollama

/**
 * @typedef {Object} TrackEmbedding
 * @property {number[]} embedding   — vetor de floats
 * @property {string}   description — texto que foi embedado
 * @property {string}   title
 * @property {string}   artist
 * @property {string}   album
 * @property {string}   processedAt — ISO date
 */

export class EmbeddingService {
  /**
   * @param {{
   *   axios: object,
   *   libraryScanner: object,
   *   audioAnalyzer?: object,
   *   ollamaUrl: string,
   *   embeddingModel?: string,
   *   storageFile?: string|false
   * }} config
   *
   * audioAnalyzer — instância de AudioAnalyzerService (opcional).
   *   Se presente, a descrição da faixa é enriquecida com features acústicas
   *   extraídas do binário de áudio via ffprobe/ffmpeg.
   *   Quando ausente ou quando a análise falha, usa apenas metadados do Plex.
   */
  constructor({ axios, libraryScanner, audioAnalyzer, ollamaUrl, embeddingModel, storageFile } = {}) {
    this._axios          = axios;
    this._libraryScanner = libraryScanner;
    this._audioAnalyzer  = audioAnalyzer || null;
    this._ollamaUrl      = ollamaUrl || "http://localhost:11434";
    this._model          = embeddingModel || process.env.EMBEDDING_MODEL || "nomic-embed-text";
    this._storageFile    = storageFile === undefined ? EMBEDDINGS_FILE : storageFile;

    /** @type {Record<string, TrackEmbedding>} */
    this._store = {};

    /** Batch job state */
    this._job = {
      running:      false,
      total:        0,
      done:         0,
      skipped:      0,
      errors:       0,
      currentTrack: null,
      startedAt:    null,
      stoppedAt:    null,
      stopRequested: false,
    };

    if (this._storageFile) this._loadFromDisk();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Estado atual do job em execução */
  getStatus() {
    return {
      ...this._job,
      stored: Object.keys(this._store).length,
      model:  this._model,
    };
  }

  /** Todos os embeddings armazenados */
  getStored() {
    return this._store;
  }

  /** Retorna o embedding de uma faixa específica (ou null) */
  getOne(ratingKey) {
    return this._store[ratingKey] ?? null;
  }

  /** Apaga todos os embeddings armazenados */
  reset() {
    this._store = {};
    this._saveStore();
    logger.info("EMBEDDING", "Store limpo");
  }

  /**
   * Gera (ou re-gera) o embedding de uma faixa usando análise de áudio nativa
   * do gemma4 via Ollama (o áudio é convertido para WAV 16kHz e enviado pelo
   * campo `images`).
   *
   * A descrição resultante inclui instrumentação, timbre, dinâmica e estilo
   * vocal detectados diretamente no áudio — muito mais ricos do que os
   * metadados do Plex.
   *
   * @param {object} track           — track metadata do Plex (mínimo: title, artist, album, genres)
   * @param {string} localPath       — caminho absoluto do arquivo de áudio
   * @param {string} ratingKey       — chave única da faixa no Plex
   * @param {object} [analyzer]      — instância MusicAnalyzer (opcional; usa this._musicAnalyzer se não passado)
   * @param {object} [options]
   * @param {number} [options.maxAudioSecs=30]
   * @returns {Promise<{ embedding: number[], description: string, analysis: object }>}
   */
  async embedTrackWithAudio(track, localPath, ratingKey, analyzer, options = {}) {
    if (!analyzer) throw new Error("embedTrackWithAudio requer uma instância MusicAnalyzer");

    const analysis = await analyzer.analyzeAudioFile(localPath, {
      title:  track.title,
      artist: track.artist,
      album:  track.album,
      genres: track.genres,
    }, options);

    // Constrói descrição semântica rica a partir da análise de áudio
    const parts = [
      `"${track.title || "Unknown"}" by ${track.artist || "Unknown Artist"}`,
      track.album ? `, album "${track.album}"` : "",
      `. Genre: ${analysis.genre}.`,
      ` Mood: ${analysis.mood}, energy ${analysis.energy}/10.`,
      analysis.timbre    ? ` Timbre: ${analysis.timbre}.`                       : "",
      analysis.tempo     ? ` Tempo: ${analysis.tempo}.`                         : "",
      analysis.dynamics  ? ` Dynamics: ${analysis.dynamics}.`                   : "",
      analysis.vocalStyle && analysis.vocalStyle !== "unknown"
                         ? ` Vocals: ${analysis.vocalStyle}.`                   : "",
      analysis.instruments?.length
                         ? ` Instruments: ${analysis.instruments.join(", ")}.`  : "",
      analysis.characteristics?.length
                         ? ` Characteristics: ${analysis.characteristics.join(", ")}.` : "",
    ];
    const description = parts.filter(Boolean).join("").trim();

    const embedding = await this._fetchEmbedding(description);

    const entry = {
      embedding,
      description,
      analysis,
      title:       track.title  || "",
      artist:      track.artist || "",
      album:       track.album  || "",
      genres:      track.genres || [],
      processedAt: new Date().toISOString(),
      source:      "audio",
    };

    this._store[String(ratingKey)] = entry;
    this._saveStore();

    logger.info("EMBEDDING", `Embedding por áudio salvo: "${track.title}" (${ratingKey})`);
    return { embedding, description, analysis };
  }

  /**
   * Inicia o processamento em lote da biblioteca inteira.
   * Tracks já processadas são ignoradas (cache por ratingKey).
   * @param {{ force?: boolean }} options — force=true reprocessa tudo
   * @returns {Promise<void>} resolve imediatamente (job corre em background)
   */
  async startBatch({ force = false } = {}) {
    if (this._job.running) throw new Error("Batch já em execução");

    // Carrega biblioteca
    const { tracks } = await this._libraryScanner.scan();
    if (!tracks.length) throw new Error("Biblioteca vazia — nada a processar");

    this._job = {
      running:       true,
      total:         tracks.length,
      done:          0,
      skipped:       0,
      errors:        0,
      currentTrack:  null,
      startedAt:     new Date().toISOString(),
      stoppedAt:     null,
      stopRequested: false,
    };

    logger.info("EMBEDDING", `Batch iniciado — ${tracks.length} faixas, modelo: ${this._model}`);

    // Roda em background (sem await)
    this._runBatch(tracks, force).catch((err) => {
      logger.error("EMBEDDING", "Batch falhou", { err: err.message });
      this._job.running = false;
    });
  }

  /** Para o batch em execução (graceful — aguarda a faixa atual terminar) */
  stopBatch() {
    if (!this._job.running) return;
    this._job.stopRequested = true;
    logger.info("EMBEDDING", "Stop solicitado — aguardando faixa atual");
  }

  /**
   * Encontra as N faixas mais similares a uma dada (cosine similarity).
   * @param {string} ratingKey
   * @param {number} limit
   * @returns {{ ratingKey, title, artist, album, similarity }[]}
   */
  getSimilarTracks(ratingKey, limit = 10) {
    const target = this._store[ratingKey];
    if (!target) return [];

    return Object.entries(this._store)
      .filter(([k]) => k !== ratingKey)
      .map(([k, v]) => ({
        ratingKey: k,
        title:     v.title,
        artist:    v.artist,
        album:     v.album,
        similarity: this._cosine(target.embedding, v.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Embeda um texto livre e retorna as N faixas mais similares semanticamente.
   * Usado pelo PlaylistBuilder para pré-filtrar candidatos a partir do prompt.
   *
   * @param {string} text  — o texto a ser embedado (ex: prompt do usuário)
   * @param {number} limit — número máximo de resultados
   * @returns {Promise<{ ratingKey, title, artist, album, genres, similarity }[]>}
   */
  async searchByText(text, limit = 20) {
    if (Object.keys(this._store).length === 0) return [];

    const queryVec = await this._fetchEmbedding(text);

    return Object.entries(this._store)
      .map(([k, v]) => ({
        ratingKey:  k,
        title:      v.title,
        artist:     v.artist,
        album:      v.album,
        genres:     v.genres || [],
        similarity: this._cosine(queryVec, v.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ─── Private: batch loop ─────────────────────────────────────────────────────

  async _runBatch(tracks, force) {
    for (const track of tracks) {
      if (this._job.stopRequested) break;

      const key = String(track.ratingKey);

      // Cache: pular se já processado (a menos que force=true)
      if (!force && this._store[key]) {
        this._job.skipped++;
        this._job.done++;
        continue;
      }

      this._job.currentTrack = `"${track.title}" — ${track.artist}`;

      try {
        const text = await this._buildDescription(track);
        const embedding = await this._fetchEmbedding(text);
        this._store[key] = {
          embedding,
          description: text,
          title:       track.title  || "",
          artist:      track.artist || "",
          album:       track.album  || "",
          genres:      track.genres || [],
          processedAt: new Date().toISOString(),
        };
        this._job.done++;
        // Salva a cada 50 faixas para não perder progresso
        if (this._job.done % 50 === 0) this._saveStore();
      } catch (err) {
        logger.warn("EMBEDDING", `Falha na faixa "${track.title}": ${err.message}`);
        this._job.errors++;
        this._job.done++;
      }

      // Pausa mínima para não saturar o Ollama
      await this._sleep(BATCH_DELAY_MS);
    }

    // Salva estado final
    this._saveStore();
    this._job.running      = false;
    this._job.currentTrack = null;
    this._job.stoppedAt    = new Date().toISOString();

    const wasForced = this._job.stopRequested ? " (interrompido)" : " (concluído)";
    logger.info("EMBEDDING", `Batch${wasForced}`, {
      done:    this._job.done,
      skipped: this._job.skipped,
      errors:  this._job.errors,
    });
  }

  // ─── Private: description + embedding ────────────────────────────────────────

  /**
   * Constrói a descrição textual da faixa para embedding.
   *
   * Se um AudioAnalyzerService estiver disponível e o arquivo de áudio acessível,
   * enriquece a descrição com features acústicas reais (RMS, peak, dinâmica, BPM, codec).
   * Caso contrário, usa apenas metadados do Plex.
   *
   * @param {object} track — track metadata do Plex (pode incluir Media[0].Part[0].file)
   * @returns {Promise<string>}
   */
  async _buildDescription(track) {
    // Tenta análise acústica se audioAnalyzer configurado
    if (this._audioAnalyzer) {
      const plexFilePath = track.Media?.[0]?.Part?.[0]?.file ?? null;
      if (plexFilePath) {
        try {
          const features = await this._audioAnalyzer.analyze(plexFilePath);
          if (features) {
            return this._audioAnalyzer.buildAcousticDescription(track, features);
          }
        } catch (err) {
          logger.warn("EMBEDDING", `Análise acústica falhou para "${track.title}": ${err.message} — usando metadados`);
        }
      }
    }

    // Fallback: descrição baseada apenas em metadados do Plex
    const genreCtx = buildGenreContext(track.genres || []);
    const parts = [
      `"${track.title || "Unknown"}" by ${track.artist || "Unknown Artist"}`,
      track.album ? `, album "${track.album}"` : "",
      genreCtx ? `. Genres: ${genreCtx}.` : ".",
    ];
    return parts.join("");
  }

  /**
   * Chama a API de embedding do Ollama.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async _fetchEmbedding(text) {
    // Suporta tanto /api/embed (Ollama ≥ 0.3) quanto /api/embeddings (legado)
    const url = `${this._ollamaUrl}/api/embed`;
    try {
      const res = await this._axios.post(url, {
        model: this._model,
        input: text,
      }, { timeout: 30000 });

      // Pode retornar { embeddings: [[...]] } ou { embedding: [...] }
      const raw = res.data?.embeddings?.[0] ?? res.data?.embedding;
      if (!Array.isArray(raw) || !raw.length) {
        throw new Error("Resposta inesperada do Ollama embed: " + JSON.stringify(res.data).slice(0, 200));
      }
      return raw;
    } catch (err) {
      if (err.response?.status === 404) {
        // Fallback para endpoint legado
        const res2 = await this._axios.post(`${this._ollamaUrl}/api/embeddings`, {
          model: this._model,
          prompt: text,
        }, { timeout: 30000 });
        const raw2 = res2.data?.embedding;
        if (!Array.isArray(raw2) || !raw2.length) throw new Error("Embedding vazio (fallback)");
        return raw2;
      }
      throw err;
    }
  }

  // ─── Private: storage ────────────────────────────────────────────────────────

  _loadFromDisk() {
    try {
      if (!existsSync(this._storageFile)) return;
      const raw = readFileSync(this._storageFile, "utf-8");
      this._store = JSON.parse(raw);
      logger.info("EMBEDDING", `${Object.keys(this._store).length} embeddings carregados do disco`);
    } catch (err) {
      logger.warn("EMBEDDING", `Não foi possível carregar ${this._storageFile}: ${err.message}`);
    }
  }

  _saveStore() {
    if (!this._storageFile) return;
    try {
      if (!existsSync(EMBEDDINGS_DIR)) mkdirSync(EMBEDDINGS_DIR, { recursive: true });
      writeFileSync(this._storageFile, JSON.stringify(this._store, null, 2), "utf-8");
    } catch (err) {
      logger.warn("EMBEDDING", `Não foi possível salvar embeddings: ${err.message}`);
    }
  }

  // ─── Private: math ───────────────────────────────────────────────────────────

  _cosine(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot   += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
