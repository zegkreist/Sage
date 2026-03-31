/**
 * HistoryService — lê o histórico de reprodução do Plex
 *
 * Endpoint: GET /status/sessions/history/all
 *   params: sort=viewedAt:desc, limit=N, type=10 (tracks)
 */
export class HistoryService {
  /**
   * @param {{ axios: object, plexUrl: string, plexToken: string }} config
   */
  constructor({ axios, plexUrl, plexToken } = {}) {
    this.axios = axios;
    this.plexUrl = plexUrl || process.env.PLEX_URL || "http://localhost:32400";
    this.plexToken = plexToken || process.env.PLEX_TOKEN || "";
  }

  get _headers() {
    return {
      "X-Plex-Token": this.plexToken,
      Accept: "application/json",
    };
  }

  /**
   * Retorna faixas ouvidas recentemente.
   * @param {number} limit — máximo de registros (padrão 50)
   * @returns {Promise<Array<{title, artist, album, playedAt}>>}
   */
  async getRecentlyPlayed(limit = 50) {
    try {
      const res = await this.axios.get(
        `${this.plexUrl}/status/sessions/history/all`,
        {
          headers: this._headers,
          params: { sort: "viewedAt:desc", limit, type: 10 },
        }
      );

      const items = res.data?.MediaContainer?.Metadata || [];
      return items.map((item) => ({
        title: item.title,
        artist: item.grandparentTitle,
        album: item.parentTitle,
        playedAt: item.viewedAt,
      }));
    } catch (err) {
      console.warn("[HistoryService] Erro ao obter histórico:", err.message);
      return [];
    }
  }

  /**
   * Retorna artistas favoritos ordenados por contagem de plays.
   * @param {number} limit — máximo de artistas (padrão 20)
   * @returns {Promise<Array<{artist, playCount}>>}
   */
  async getFavoriteArtists(limit = 20) {
    try {
      const history = await this.getRecentlyPlayed(500);
      if (!history.length) return [];

      const counts = {};
      for (const track of history) {
        if (track.artist) {
          counts[track.artist] = (counts[track.artist] || 0) + 1;
        }
      }

      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([artist, playCount]) => ({ artist, playCount }));
    } catch (err) {
      console.warn("[HistoryService] Erro ao calcular favoritos:", err.message);
      return [];
    }
  }
}
