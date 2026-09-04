import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../data");

/**
 * FavoritesService — curadoria pessoal (estrelas e notas 0-5 por faixa).
 *
 * A chave é normalizada de artist+title+album, então o favorito sobrevive a
 * moves de arquivo e a mudanças de ratingKey no Plex.
 * Estrutura: { favorites: { "<key>": { artist, title, album, starred, rating, updatedAt } } }
 */
export class FavoritesService {
  constructor({ dataDir } = {}) {
    this.file = path.join(dataDir || _DATA_DIR, "favorites.json");
    this._favorites = new Map();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [k, v] of Object.entries(raw.favorites || {})) {
        this._favorites.set(k, v);
      }
      logger.info("FAVORITES", `${this._favorites.size} favorito(s) carregado(s)`);
    } catch (err) {
      if (err.code !== "ENOENT") logger.warn("FAVORITES", `Falha ao carregar ${this.file}: ${err.message}`);
    }
    return this;
  }

  /** Chave estável normalizada (sobrevive a renomeação/moves). */
  static makeKey(artist = "", title = "", album = "") {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return [norm(artist), norm(title), norm(album)].join("|");
  }

  /** Lista todos como array (mais recentes primeiro). */
  list() {
    return [...this._favorites.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Mapa key → entry (para filtros rápidos). */
  map() {
    return this._favorites;
  }

  /** Conjunto de chaves com estrela (para filtrar candidatos de playlist). */
  starredKeys() {
    const keys = new Set();
    for (const [k, v] of this._favorites) {
      if (v.starred) keys.add(k);
    }
    return keys;
  }

  get(artist, title, album) {
    return this._favorites.get(FavoritesService.makeKey(artist, title, album)) ?? null;
  }

  /**
   * Cria/atualiza um favorito.
   * @param {{artist?: string, title?: string, album?: string}} track
   * @param {{starred?: boolean, rating?: number|null}} patch
   */
  setFavorite(track, patch = {}) {
    const key = FavoritesService.makeKey(track.artist, track.title, track.album);
    const prev = this._favorites.get(key) || {};
    const entry = {
      artist: track.artist || prev.artist || "",
      title:  track.title  || prev.title  || "",
      album:  track.album  || prev.album  || "",
      starred: typeof patch.starred === "boolean" ? patch.starred : prev.starred ?? false,
      rating:  patch.rating !== undefined
        ? (patch.rating === null ? null : Math.max(0, Math.min(5, Math.round(patch.rating))))
        : prev.rating ?? null,
      updatedAt: Date.now(),
    };
    // Sem estrela e sem nota → remove (favorito vazio não persiste)
    if (!entry.starred && entry.rating == null) {
      this._favorites.delete(key);
      this._save();
      return null;
    }
    this._favorites.set(key, entry);
    this._save();
    return entry;
  }

  remove(artist, title, album) {
    const key = FavoritesService.makeKey(artist, title, album);
    const existed = this._favorites.delete(key);
    if (existed) this._save();
    return existed;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ favorites: Object.fromEntries(this._favorites) }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.warn("FAVORITES", `Falha ao salvar ${this.file}: ${err.message}`);
    }
  }
}
