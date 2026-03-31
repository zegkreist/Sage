import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Pasta de dados: ../../mediasage/playlists/ (relativa ao agent)
const PLAYLISTS_DIR = join(__dirname, "../../../../mediasage/playlists");
const PLAYLISTS_FILE = join(PLAYLISTS_DIR, "playlists.json");

/**
 * PlaylistBuilder — gera e persiste playlists a partir da biblioteca.
 *
 * As playlists são guardadas em memória (Map) e também em disco
 * (mediasage/playlists/playlists.json) para sobreviver a reinícios.
 */
export class PlaylistBuilder {
  /**
   * @param {{ allfather: object, libraryScanner: object, storageFile?: string|false }} config
   *   storageFile — caminho do ficheiro JSON de persistência; `false` desabilita o disco (usado em testes)
   */
  constructor({ allfather, libraryScanner, storageFile } = {}) {
    this.allfather = allfather;
    this.libraryScanner = libraryScanner;
    // storageFile=false desabilita persistência em disco (útil em testes)
    this._storageFile = storageFile === undefined ? PLAYLISTS_FILE : storageFile;
    this._store = new Map();
    if (this._storageFile) this._loadFromDisk();
  }

  /**
   * Gera uma playlist baseada em critérios com ajuda do Ollama.
   * @param {{ name?, mood?, genre?, energy?, size? }} options
   * @returns {Promise<{id, name, mood, genre, tracks[], createdAt}>}
   */
  async generate({ name, mood, genre, energy, size = 10 } = {}) {
    const playlistName = name || this._autoName({ mood, genre });
    logger.info("PLAYLIST", `generate() iniciado — "${playlistName}"`, { mood, genre, energy, size });

    try {
      // Garante que a biblioteca está carregada
      const { tracks } = await this.libraryScanner.scan();

      if (!tracks.length) {
        logger.warn("PLAYLIST", "Biblioteca vazia — retornando playlist vazia");
        return this._emptyPlaylist(playlistName, { mood, genre });
      }

      const trackList = tracks
        .slice(0, 200) // limita prompt size
        .map((t) => ({
          ratingKey: t.ratingKey,
          title: t.title,
          artist: t.grandparentTitle,
          album: t.parentTitle,
        }));

      logger.debug("PLAYLIST", `Enviando ${trackList.length} faixas ao Ollama para seleção`);
      const t0 = Date.now();
      const prompt = this._buildPlaylistPrompt({ playlistName, mood, genre, energy, size, trackList });
      const selected = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens: 2000 });
      logger.debug("OLLAMA", `askForJSON respondeu em ${Date.now() - t0}ms`);

      const tracksArray = Array.isArray(selected) ? selected : (selected?.tracks ?? []);

      const playlist = {
        id: randomUUID(),
        name: playlistName,
        mood: mood || null,
        genre: genre || null,
        energy: energy || null,
        tracks: tracksArray.slice(0, size),
        createdAt: new Date().toISOString(),
      };

      logger.info("PLAYLIST", `Playlist gerada: "${playlist.name}" — ${playlist.tracks.length} faixas`);
      return playlist;
    } catch (err) {
      logger.error("PLAYLIST", `Erro ao gerar playlist: ${err.message}`);
      return this._emptyPlaylist(playlistName, { mood, genre });
    }
  }

  /**
   * Salva uma playlist no store em memória e em disco.
   * @param {{ name: string, tracks: any[], [key: string]: any }} playlist
   * @returns {{ id: string, createdAt: string, ...playlist }}
   */
  save(playlist) {
    const saved = {
      ...playlist,
      id: playlist.id || randomUUID(),
      createdAt: playlist.createdAt || new Date().toISOString(),
    };
    this._store.set(saved.id, saved);
    this._saveToDisk();
    logger.debug("PLAYLIST", `save() — "${saved.name}" (id=${saved.id})`);
    return saved;
  }

  /**
   * Lista todas as playlists salvas.
   * @returns {any[]}
   */
  list() {
    return [...this._store.values()];
  }

  /**
   * Retorna playlist pelo id.
   * @param {string} id
   * @returns {any|null}
   */
  get(id) {
    return this._store.get(id) ?? null;
  }

  /**
   * Remove playlist pelo id.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    if (!this._store.has(id)) return false;
    const name = this._store.get(id)?.name;
    this._store.delete(id);
    this._saveToDisk();
    logger.info("PLAYLIST", `Playlist excluída: "${name}" (id=${id})`);
    return true;
  }

  /**
   * Atualiza campos de uma playlist existente (nome, faixas, etc.).
   * @param {string} id
   * @param {{ name?: string, tracks?: any[] }} fields
   * @returns {any|null} playlist atualizada ou null se não encontrada
   */
  update(id, fields = {}) {
    const existing = this._store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, id, updatedAt: new Date().toISOString() };
    this._store.set(id, updated);
    this._saveToDisk();
    logger.info("PLAYLIST", `Playlist atualizada: "${updated.name}" (id=${id})`, { fields: Object.keys(fields) });
    return updated;
  }

  /**
   * Gera uma playlist a partir de um prompt em linguagem natural.
   * Usa AllFather para interpretar o texto e extrair parâmetros.
   * @param {string} prompt — texto livre do usuário
   * @returns {Promise<{id, name, mood, genre, tracks[], createdAt, prompt}>}
   */
  async generateFromPrompt(prompt) {
    logger.info("PLAYLIST", `generateFromPrompt() chamado`, { prompt: prompt.slice(0, 120) });
    let params = { name: null, mood: null, genre: null, energy: null, size: 10 };

    try {
      const t0 = Date.now();
      const extracted = await this.allfather.askForJSON(
        `You are a music assistant. Extract playlist parameters from this user request:
"${prompt}"

Return a JSON object with these exact fields (use null for fields not mentioned):
{
  "name": "playlist name based on the request, or null to auto-generate",
  "mood": "one word mood (e.g. relaxed, energetic, melancholic, happy, dark, upbeat) or null",
  "genre": "primary genre string or null",
  "energy": <integer 1-10 or null>,
  "size": <integer number of tracks, default 10 if not specified>
}`,
        { temperature: 0.2 }
      );
      logger.debug("OLLAMA", `Parâmetros extraídos em ${Date.now() - t0}ms`, extracted);
      params = { ...params, ...extracted };
      logger.info("PLAYLIST", `Parâmetros do prompt`, params);
    } catch (err) {
      logger.warn("PLAYLIST", `Falha ao interpretar prompt — usando parâmetros padrão: ${err.message}`);
    }

    const playlist = await this.generate(params);
    return { ...playlist, prompt };
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  _autoName({ mood, genre }) {
    const date = new Date().toLocaleDateString("pt-BR");
    if (mood && genre) return `${genre} ${mood} — ${date}`;
    if (mood) return `Playlist ${mood} — ${date}`;
    if (genre) return `${genre} Mix — ${date}`;
    return `Mix — ${date}`;
  }

  _emptyPlaylist(name, { mood, genre } = {}) {
    return {
      id: randomUUID(),
      name,
      mood: mood || null,
      genre: genre || null,
      tracks: [],
      createdAt: new Date().toISOString(),
    };
  }

  _buildPlaylistPrompt({ playlistName, mood, genre, energy, size, trackList }) {
    const criteria = [
      mood && `mood: ${mood}`,
      genre && `genre: ${genre}`,
      energy && `energy level: ${energy}/10`,
    ]
      .filter(Boolean)
      .join(", ") || "general mix";

    const trackLines = trackList
      .map((t) => `{"ratingKey":"${t.ratingKey}","title":"${t.title}","artist":"${t.artist}","album":"${t.album}"}`)
      .join(",\n");

    return `You are a DJ creating a playlist called "${playlistName}".
Playlist criteria: ${criteria}.
Select exactly ${size} tracks from the following library that best match the criteria.

Available tracks:
[
${trackLines}
]

Return a JSON array of exactly ${size} selected tracks. Each item must keep ALL original fields:
{ "ratingKey": "...", "title": "...", "artist": "...", "album": "..." }

Return ONLY the JSON array. Choose tracks that create a cohesive listening experience for: ${criteria}.`;
  }

  _saveToDisk() {
    if (!this._storageFile) return;
    try {
      const dir = dirname(this._storageFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this._storageFile, JSON.stringify(this.list(), null, 2), "utf8");
      logger.debug("PLAYLIST", `Playlists salvas em disco (${this._store.size} total)`);
    } catch (err) {
      logger.warn("PLAYLIST", `Não foi possível salvar playlists em disco: ${err.message}`);
    }
  }

  _loadFromDisk() {
    try {
      if (existsSync(this._storageFile)) {
        const data = JSON.parse(readFileSync(this._storageFile, "utf8"));
        if (Array.isArray(data)) {
          data.forEach((p) => this._store.set(p.id, p));
        }
      }
    } catch (err) {
      // Silencia erros de leitura — store começa vazio
    }
  }
}
