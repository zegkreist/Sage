import TorrentSearchApi from "torrent-search-api";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Jackett category IDs (Torznab standard)
const JACKETT_CAT = {
  movie:  [2000],           // Movies
  series: [5000],           // TV
  music:  [3000],           // Audio
};

class TorrentSearch {
  constructor() {
    this.api = TorrentSearchApi;
    this.initialized = false;
    this.config = this.loadConfig();
    this._log = (level, msg) => console.log(`[${level.toUpperCase()}] ${msg}`);

    // Jackett — URL via env, API key via env OU lida do ServerConfig.json do Jackett
    this.jackettUrl    = (process.env.JACKETT_URL || "http://192.168.15.14:9117").replace(/\/$/, "");
    this.jackettApiKey = process.env.JACKETT_API_KEY || this._readJackettApiKey();
  }

  setLogger(fn) {
    this._log = fn;
  }

  /**
   * Lê a API key diretamente do ServerConfig.json do Jackett.
   * Funciona quando o volume ./jackett/config está montado em /jackett-config.
   */
  _readJackettApiKey() {
    const candidates = [
      "/jackett-config/Jackett/ServerConfig.json",
      "/ZimaOS-HD/AppData/flaresolverr/config/Jackett/ServerConfig.json",
      path.join(__dirname, "../../../../jackett/config/Jackett/ServerConfig.json"),
    ];
    for (const p of candidates) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        const key = cfg.APIKey || cfg.ApiKey || cfg.apiKey || cfg.api_key;
        if (key) {
          this._log("info", `Jackett API key lida de: ${p}`);
          return key;
        }
        this._log("warn", `Jackett: arquivo encontrado em ${p} mas sem campo APIKey. Campos: ${Object.keys(cfg).join(", ")}`);
      } catch (e) {
        this._log("debug", `Jackett: não conseguiu ler ${p}: ${e.code || e.message}`);
      }
    }
    this._log("warn", "Jackett: API key não encontrada em nenhum caminho candidato");
    return "";
  }

  get hasJackett() {
    // Re-tenta ler a key a cada verificação (Jackett pode ter iniciado depois do Sage)
    if (!this.jackettApiKey) {
      this.jackettApiKey = this._readJackettApiKey();
    }
    const ok = !!(this.jackettUrl && this.jackettApiKey);
    if (!ok) {
      this._log("warn", `Jackett NÃO disponível — url=${this.jackettUrl} key=${this.jackettApiKey ? '(set)' : '(empty)'}`);
    }
    return ok;
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, "../config.json");
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return { search: { providers: [] } };
    }
  }

  // ── Jackett search ────────────────────────────────────────────────────────

  /**
   * Busca no Jackett via Torznab aggregate endpoint.
   * Retorna resultados no mesmo formato que torrent-search-api.
   */
  async _jackettSearch(query, type) {
    const cats = (JACKETT_CAT[type] || []).join(",");
    const url  = `${this.jackettUrl}/api/v2.0/indexers/all/results`;
    this._log("info", `Jackett buscando: query="${query}" cats=${cats || "all"}`);

    let data;
    try {
      ({ data } = await axios.get(url, {
        params: {
          apikey:   this.jackettApiKey,
          Query:    query,
          Category: cats || undefined,
          _:        Date.now(),
        },
        timeout: 55_000,
      }));
    } catch (e) {
      const detail = e.response?.status
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
        : (e.message || e.code || JSON.stringify(e, Object.getOwnPropertyNames(e)));
      throw new Error(`Jackett request failed: ${detail}`);
    }

    const items = data?.Results ?? [];
    const indexers = data?.Indexers ?? [];
    const activeIndexers = indexers.filter(i => i.Results > 0 || i.Status === 0).length;
    this._log("info", `Jackett retornou ${items.length} resultados para "${query}" (${indexers.length} indexers, ${activeIndexers} com resultado)`);
    return items.map(r => ({
      title:    r.Title    || "",
      size:     r.Size     ? this._bytesToHuman(r.Size) : "–",
      seeds:    r.Seeders  ?? 0,
      peers:    r.Peers    ?? 0,
      provider: r.Tracker  || "Jackett",
      magnet:   r.MagnetUri || null,
      link:     r.Link      || null,
    }));
  }

  _bytesToHuman(bytes) {
    if (!bytes) return "–";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  // ── Fallback scraper ──────────────────────────────────────────────────────

  async initialize() {
    if (this.initialized) return;
    const providers = this.config.search?.providers || [];
    if (providers.length > 0) {
      for (const p of providers) {
        try { this.api.enableProvider(p); } catch { /* provider indisponível */ }
      }
    } else {
      this.api.enablePublicProviders();
    }
    this.initialized = true;
  }

  async _scraperSearch(query, category, limit = 20) {
    await this.initialize();
    const torrents = await this.api.search(query, category, limit);
    return torrents.map(r => ({
      title:    r.title    || "",
      size:     r.size     || "–",
      seeds:    typeof r.seeds === "number" ? r.seeds : 0,
      peers:    typeof r.peers === "number" ? r.peers : 0,
      provider: r.provider || "–",
      magnet:   r.magnet   || null,
      link:     r.link     || null,
    }));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async searchMovies(movieName, year = null) {
    const query = year ? `${movieName} ${year}` : movieName;
    const useJackett = this.hasJackett;
    this._log("info", `searchMovies via ${useJackett ? 'Jackett' : 'scraper'}: "${query}"`);
    const raw = useJackett
      ? await this._jackettSearch(query, "movie")
      : await this._scraperSearch(query, "Movies");
    this._log("info", `searchMovies: ${raw.length} resultados brutos`);
    return this.rankResults(raw, "movie");
  }

  async searchSeries(seriesName, season = null, episode = null) {
    let query = seriesName;
    if (season && episode) query += ` S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`;
    else if (season)       query += ` S${String(season).padStart(2,"0")}`;
    const useJackett = this.hasJackett;
    this._log("info", `searchSeries via ${useJackett ? 'Jackett' : 'scraper'}: "${query}"`);
    const raw = useJackett
      ? await this._jackettSearch(query, "series")
      : await this._scraperSearch(query, "All");
    this._log("info", `searchSeries: ${raw.length} resultados brutos`);
    return this.rankResults(raw, "series");
  }

  async searchMusic(artist, album = null) {
    const query = album ? `${artist} ${album}` : artist;
    const useJackett = this.hasJackett;
    this._log("info", `searchMusic via ${useJackett ? 'Jackett' : 'scraper'}: "${query}"`);
    const raw = useJackett
      ? await this._jackettSearch(query, "music")
      : await this._scraperSearch(query, "Audio");
    this._log("info", `searchMusic: ${raw.length} resultados brutos`);
    return this.rankResults(raw, "music");
  }

  async search(query, category = "All", limit = 10) {
    await this.initialize();
    return this.api.search(query, category, limit);
  }

  async getMagnetLink(torrent) {
    await this.initialize();
    try { return await this.api.getMagnet(torrent); } catch { return null; }
  }

  async getTorrentBuffer(torrent) {
    await this.initialize();
    try { return await this.api.downloadTorrent(torrent); } catch { return null; }
  }

  /**
   * Rankeia resultados por qualidade
   */
  rankResults(torrents, type) {
    return torrents
      .map((torrent) => {
        let score = 0;

        // Pontuação por seeders (máximo 100 pontos) - PRIORIDADE MÁXIMA
        const seeders = parseInt(torrent.seeds) || 0;
        score += Math.min(seeders / 5, 100); // Aumentado de 50 para 100 pontos

        // Pontuação por tamanho (máximo 30 pontos)
        const sizeScore = this.calculateSizeScore(torrent.size, type);
        score += sizeScore;

        // Pontuação por qualidade (máximo 40 pontos para música lossless, 20 para outros)
        const qualityScore = this.calculateQualityScore(torrent.title, type);
        score += qualityScore;

        return {
          ...torrent,
          score,
          seeders,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Calcula score baseado no tamanho do arquivo
   */
  calculateSizeScore(sizeStr, type) {
    if (!sizeStr) return 0;

    const size = this.parseSizeToMB(sizeStr);

    if (type === "movie") {
      // Filmes ideais: 1.5GB - 10GB
      if (size >= 1500 && size <= 10000) return 30;
      if (size >= 800 && size < 1500) return 20;
      if (size > 10000 && size <= 15000) return 15;
      return 5;
    } else if (type === "series") {
      // Episódios ideais: 200MB - 2GB
      if (size >= 200 && size <= 2000) return 30;
      if (size >= 100 && size < 200) return 20;
      if (size > 2000 && size <= 4000) return 15;
      return 5;
    } else if (type === "music") {
      // Álbuns FLAC: 200MB - 1GB (lossless é maior)
      if (size >= 200 && size <= 1000) return 30;
      // Álbuns MP3 320: 50MB - 200MB
      if (size >= 50 && size < 200) return 25;
      // Álbuns menores (128/192kbps)
      if (size >= 20 && size < 50) return 15;
      return 10;
    }

    return 10;
  }

  /**
   * Calcula score baseado na qualidade
   */
  calculateQualityScore(title, type) {
    const titleLower = title.toLowerCase();
    let score = 0;

    // Para músicas, priorizar FLAC/Lossless
    if (type === "music") {
      if (titleLower.includes("flac") || titleLower.includes("lossless") || titleLower.includes("hi-res")) {
        score += 40; // PRIORIDADE MÁXIMA para lossless
      } else if (titleLower.includes("320") || titleLower.includes("320kbps")) {
        score += 15;
      } else if (titleLower.includes("256") || titleLower.includes("v0")) {
        score += 10;
      }
      return score;
    }

    // Qualidade de vídeo
    if (titleLower.includes("2160p") || titleLower.includes("4k")) score += 20;
    else if (titleLower.includes("1080p")) score += 15;
    else if (titleLower.includes("720p")) score += 10;
    else if (titleLower.includes("480p")) score += 5;

    // Codec
    if (titleLower.includes("x265") || titleLower.includes("hevc")) score += 5;

    // Áudio de vídeos
    if (titleLower.includes("atmos") || titleLower.includes("truehd")) score += 5;
    else if (titleLower.includes("dts") || titleLower.includes("dd5.1")) score += 3;

    return score;
  }

  /**
   * Converte string de tamanho para MB
   */
  parseSizeToMB(sizeStr) {
    if (!sizeStr) return 0;

    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB)/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    if (unit === "GB") return value * 1024;
    if (unit === "MB") return value;
    if (unit === "KB") return value / 1024;

    return 0;
  }
}

export default new TorrentSearch();
