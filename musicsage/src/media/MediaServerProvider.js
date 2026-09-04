/**
 * Contrato que todo servidor de mídia precisa cumprir para o MusicSage funcionar.
 *
 * Hoje só existe o PlexProvider. Para plugar outro servidor (Jellyfin, Emby,
 * Navidrome), escreva uma classe que estenda esta, implemente os getters e
 * registre-a em `src/media/index.js` — nada fora de `src/media/` precisa saber
 * qual servidor está rodando.
 *
 * ── Formato canônico ──
 * O app inteiro (rotas, PlaylistBuilder, cache de análise, frontend) consome
 * faixas no formato abaixo, que é o do Plex. Um provider novo NÃO deve vazar o
 * formato nativo dele: traduza no adaptador antes de devolver.
 *
 * @typedef {object} CanonicalTrack
 * @property {string} ratingKey        — id único e estável da faixa no servidor
 * @property {string} title            — título da faixa
 * @property {string} grandparentTitle — artista
 * @property {string} parentTitle      — álbum
 * @property {number} [viewCount]      — quantas vezes foi tocada
 * @property {number} [lastViewedAt]   — epoch em SEGUNDOS da última reprodução
 * @property {number} [duration]       — duração em milissegundos
 * @property {string} [thumb]          — caminho da capa, relativo ao servidor
 * @property {object} [Media]          — mídia/arquivo, no formato Media[0].Part[0].file
 */

export class NotImplementedError extends Error {
  constructor(providerType, member) {
    super(`O provider "${providerType}" não implementa "${member}"`);
    this.name = "NotImplementedError";
  }
}

export class MediaServerProvider {
  /** Identificador curto usado pela factory e pelas rotas (ex: "plex"). */
  static type = "abstract";

  get type() {
    return /** @type {typeof MediaServerProvider} */ (this.constructor).type;
  }

  _missing(member) {
    return new NotImplementedError(this.type, member);
  }

  /**
   * Biblioteca musical.
   * @returns {{
   *   scan: () => Promise<{artists: object[], albums: object[], tracks: CanonicalTrack[]}>,
   *   getArtistNames: () => string[],
   *   getGenres: () => string[],
   *   getArtistsWithGenres: () => object[],
   *   getLibraryStats: () => object,
   * }}
   */
  get library() { throw this._missing("library"); }

  /**
   * Histórico de reprodução.
   * @returns {{
   *   getRecentlyPlayed: (limit?: number) => Promise<object[]>,
   *   getRecentlyPlayedFull: (limit?: number, userId?: string|null) => Promise<object[]>,
   *   getPlayedSince: (fromTs: number, limit?: number, userId?: string|null) => Promise<object[]>,
   *   getFavoriteArtists: (limit?: number, userId?: string|null) => Promise<object[]>,
   *   getFavoriteTracks: (limit?: number, userId?: string|null) => Promise<object[]>,
   * }}
   */
  get history() { throw this._missing("history"); }

  /**
   * Métricas do período e proxy de capas.
   * @returns {{ getMetrics: Function, getThumb: Function }}
   */
  get metrics() { throw this._missing("metrics"); }

  /**
   * Playlists no servidor.
   * @returns {{
   *   pushPlaylist: (name: string, ids: string[]) => Promise<{plexId: string}>,
   *   renamePlaylist: (id: string, newName: string) => Promise<any>,
   *   updatePlaylistTracks: (id: string, name: string, ids: string[]) => Promise<any>,
   *   deletePlaylist: (id: string) => Promise<any>,
   * }}
   */
  get playlists() { throw this._missing("playlists"); }

  /**
   * Notas do usuário. `supported: false` desliga a sincronização sem quebrar
   * nada — o MusicSage continua guardando a nota localmente.
   * @returns {{ supported: boolean, setTrackRating: (id: string, rating0to5: number|null) => Promise<void> }}
   */
  get ratings() {
    return {
      supported: false,
      setTrackRating: async () => { throw this._missing("ratings.setTrackRating"); },
    };
  }

  /** Contas/perfis do servidor. @returns {Promise<Array<{id, name, thumb}>>} */
  async getUsers() { throw this._missing("getUsers"); }

  /** Ping + identificação do servidor. @returns {Promise<object>} */
  async checkConnection() { throw this._missing("checkConnection"); }

  /**
   * Como o servidor está configurado — sem vazar credencial.
   * @returns {{ type: string, url: string, tokenPresent: boolean, tokenMasked: string }}
   */
  describe() { throw this._missing("describe"); }

  /** Troca a credencial em runtime (ex: token recarregado do disco). */
  applyToken() { throw this._missing("applyToken"); }
}
