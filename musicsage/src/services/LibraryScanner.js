/**
 * LibraryScanner — lê a biblioteca musical do Plex
 *
 * Plex API types:
 *   type=8  → Artist
 *   type=9  → Album
 *   type=10 → Track
 */
const SCAN_TTL_MS = 60_000;      // snapshot válido por 1 min — rotas repetidas não refazem o scan
const SCAN_RETRY_MS = 15_000;    // após falha, só tenta de novo depois desse cooldown
const PLEX_TIMEOUT_MS = 10_000;  // Plex pendurado não pode deixar scan pendurado para sempre

export class LibraryScanner {
  /**
   * @param {{ axios: object, plexUrl: string, plexToken: string }} config
   *   axios    — instância axios (injetada para facilitar testes)
   *   plexUrl  — URL base do Plex (ex: http://localhost:32400)
   *   plexToken — token de autenticação Plex
   */
  constructor({ axios, plexUrl, plexToken } = {}) {
    this.axios = axios;
    this.plexUrl = plexUrl || process.env.PLEX_URL || "http://localhost:32400";
    this.plexToken = plexToken || process.env.PLEX_TOKEN || "";

    this._artists = [];
    this._albums = [];
    this._tracks = [];
    this._musicKey = null;
    this._scanPromise = null;   // scan em andamento — chamadas concorrentes compartilham
    this._lastSuccessAt = 0;    // idade do snapshot atual
    this._lastAttemptAt = 0;    // última tentativa (sucesso ou falha)
  }

  get _headers() {
    return {
      "X-Plex-Token": this.plexToken,
      Accept: "application/json",
    };
  }

  /**
   * Escaneia a biblioteca completa (artistas, álbuns, faixas).
   * Com cache: snapshot válido por SCAN_TTL_MS, chamadas concorrentes
   * compartilham a mesma promise, e falha NUNCA zera o último snapshot —
   * apenas mantém o estado anterior e respeita um cooldown antes de retry.
   * @returns {{ artists: any[], albums: any[], tracks: any[] }}
   */
  async scan() {
    const now = Date.now();
    if (this._scanPromise) return this._scanPromise;

    const snapshotFresh =
      this._lastSuccessAt > 0 && now - this._lastSuccessAt < SCAN_TTL_MS;
    const lastAttemptFailed = this._lastAttemptAt > this._lastSuccessAt;
    const inFailCooldown =
      lastAttemptFailed && now - this._lastAttemptAt < SCAN_RETRY_MS;

    if (snapshotFresh || inFailCooldown) return this._snapshot();

    this._scanPromise = this._doScan().finally(() => {
      this._scanPromise = null;
    });
    return this._scanPromise;
  }

  _snapshot() {
    return { artists: this._artists, albums: this._albums, tracks: this._tracks };
  }

  async _doScan() {
    this._lastAttemptAt = Date.now();
    try {
      await this._findMusicSection();
      if (!this._musicKey) {
        // Seção de música sumiu (Plex reiniciando?) — mantém snapshot anterior
        console.warn("[LibraryScanner] Seção de música não encontrada — mantendo snapshot anterior");
        return this._snapshot();
      }

      await Promise.all([
        this._fetchArtists(),
        this._fetchAlbums(),
        this._fetchTracks(),
      ]);
      this._lastSuccessAt = Date.now();
    } catch (err) {
      // Mantém o último snapshot bom — erro transitório do Plex não pode
      // apagar a biblioteca em memória (stats/autocomplete/recomendações)
      console.warn("[LibraryScanner] Erro ao escanear biblioteca (mantendo snapshot anterior):", err.message);
    }

    return this._snapshot();
  }

  /**
   * Retorna nomes de artistas (requer scan() anterior).
   * @returns {string[]}
   */
  getArtistNames() {
    return this._artists.map((a) => a.title);
  }

  /**
   * Retorna gêneros únicos da biblioteca (requer scan() anterior).
   * @returns {string[]}
   */
  getGenres() {
    const genreSet = new Set();
    for (const artist of this._artists) {
      // Plex API retorna "Genre" (maiúsculo); mocks de teste usam "genre" (minúsculo)
      const genres = artist.Genre || artist.genre;
      if (Array.isArray(genres)) {
        genres.forEach((g) => genreSet.add(g.tag));
      }
    }
    return [...genreSet];
  }

  /**
   * Retorna artistas com seus gêneros (requer scan() anterior).
   * @returns {Array<{name: string, genres: string[]}>}
   */
  getArtistsWithGenres() {
    return this._artists.map((a) => {
      const genres = a.Genre || a.genre;
      return {
        name: a.title,
        genres: Array.isArray(genres) ? genres.map((g) => g.tag) : [],
      };
    });
  }

  /**
   * Retorna estatísticas da biblioteca.
   * @returns {{ totalArtists: number, totalAlbums: number, totalTracks: number, topGenres: string[] }}
   */
  getLibraryStats() {
    const genres = this.getGenres();
    // Conta frequência de gêneros por artista
    const freq = {};
    for (const artist of this._artists) {
      // Plex API retorna "Genre" (maiúsculo); mocks de teste usam "genre" (minúsculo)
      const genres = artist.Genre || artist.genre;
      if (Array.isArray(genres)) {
        genres.forEach((g) => {
          freq[g.tag] = (freq[g.tag] || 0) + 1;
        });
      }
    }
    const topGenres = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([g]) => g);

    return {
      totalArtists: this._artists.length,
      totalAlbums: this._albums.length,
      totalTracks: this._tracks.length,
      topGenres: topGenres.length ? topGenres : genres.slice(0, 10),
    };
  }

  // ── Internos ────────────────────────────────────────────────────────────

  async _findMusicSection() {
    const res = await this.axios.get(`${this.plexUrl}/library/sections`, {
      headers: this._headers,
      timeout: PLEX_TIMEOUT_MS,
    });
    const dirs = res.data?.MediaContainer?.Directory || [];
    const music = dirs.find((d) => d.type === "artist");
    this._musicKey = music ? music.key : null;
  }

  async _fetchArtists() {
    const res = await this.axios.get(
      `${this.plexUrl}/library/sections/${this._musicKey}/all`,
      { headers: this._headers, params: { type: 8 }, timeout: PLEX_TIMEOUT_MS }
    );
    this._artists = res.data?.MediaContainer?.Metadata || [];
  }

  async _fetchAlbums() {
    const res = await this.axios.get(
      `${this.plexUrl}/library/sections/${this._musicKey}/all`,
      { headers: this._headers, params: { type: 9 }, timeout: PLEX_TIMEOUT_MS }
    );
    this._albums = res.data?.MediaContainer?.Metadata || [];
  }

  async _fetchTracks() {
    const res = await this.axios.get(
      `${this.plexUrl}/library/sections/${this._musicKey}/all`,
      { headers: this._headers, params: { type: 10 }, timeout: PLEX_TIMEOUT_MS }
    );
    this._tracks = res.data?.MediaContainer?.Metadata || [];
  }
}
