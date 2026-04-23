/**
 * MetricsService — agrega métricas de reprodução para a página de retrospectiva.
 *
 * Usa os endpoints Plex:
 *   /library/sections/{key}/all?type=10&sort=lastViewedAt:desc  → faixas
 *   /library/sections/{key}/all?type=8                          → artistas (gêneros + thumb)
 *
 * "Período" é filtrado server-side usando o campo lastViewedAt de cada faixa.
 * O playCount exibido é o viewCount total do Plex (acumulado, não restrito ao período).
 */
export class MetricsService {
  constructor({ axios, plexUrl, plexToken, analysisCache } = {}) {
    this.axios         = axios;
    this.plexUrl       = plexUrl   || process.env.PLEX_URL   || "http://localhost:32400";
    this.plexToken     = plexToken || process.env.PLEX_TOKEN || "";
    this.analysisCache = analysisCache || null;
    this._musicKey     = null;
  }

  get _headers() {
    return { "X-Plex-Token": this.plexToken, Accept: "application/json" };
  }

  async _findMusicSection() {
    if (this._musicKey) return;
    const res  = await this.axios.get(`${this.plexUrl}/library/sections`, { headers: this._headers });
    const dirs = res.data?.MediaContainer?.Directory || [];
    const music = dirs.find((d) => d.type === "artist");
    if (!music) throw new Error("Nenhuma biblioteca de música encontrada no Plex");
    this._musicKey = music.key;
  }

  /** Retorna Unix timestamp (seconds) para início do período. */
  _periodStart(period) {
    const now = Math.floor(Date.now() / 1000);
    if (period === "week")  return now - 7   * 86400;
    if (period === "month") return now - 30  * 86400;
    if (period === "year")  return now - 365 * 86400;
    return 0;
  }

  /**
   * Retorna métricas de reprodução agregadas para o período solicitado.
   * @param {"week"|"month"|"year"} period
   * @param {number|null} userId — accountID Plex para filtrar por usuário (null = todos)
   * @returns {Promise<object>}
   */
  async getMetrics(period = "month", userId = null) {
    await this._findMusicSection();
    const startTs = this._periodStart(period);

    const trackParams = { type: 10, sort: "lastViewedAt:desc", limit: 2000 };
    if (userId) trackParams.accountID = userId;

    // Faixas ordenadas por lastViewedAt decrescente
    const trackRes = await this.axios.get(
      `${this.plexUrl}/library/sections/${this._musicKey}/all`,
      { headers: this._headers, params: trackParams }
    );
    const allTracks = trackRes.data?.MediaContainer?.Metadata || [];

    // Filtra faixas reproduzidas no período
    const tracks = startTs > 0
      ? allTracks.filter((t) => (t.lastViewedAt || 0) >= startTs)
      : allTracks;

    const artistParams = { type: 8, limit: 2000 };
    if (userId) artistParams.accountID = userId;

    // Artistas: para gêneros e thumb
    const artistRes = await this.axios.get(
      `${this.plexUrl}/library/sections/${this._musicKey}/all`,
      { headers: this._headers, params: artistParams }
    );
    const artistMeta = artistRes.data?.MediaContainer?.Metadata || [];
    const artistMap  = Object.fromEntries(artistMeta.map((a) => [a.title, a]));

    // Agregação
    const trackMap         = {};
    const artistAgg        = {};
    const artistSubgenres  = {};  // artistKey → { genre: count }   (chave = grandparentRatingKey ou nome)
    const artistSgMap      = {};  // artistKey → { subgenre: count }
    const genreAgg         = {};
    const analysisGenreAgg = {};

    for (const t of tracks) {
      const plays      = t.viewCount || 0;
      if (plays === 0) continue;
      const durationMs = t.duration  || 0;
      const artistName = t.grandparentTitle || "?";
      // grandparentRatingKey é único por entidade-artista no Plex → evita colisão de nomes iguais
      const artistKey  = t.grandparentRatingKey ? String(t.grandparentRatingKey) : artistName;
      const artObj     = artistMap[artistName];

      // Faixa (deduplica por ratingKey)
      if (!trackMap[t.ratingKey]) {
        trackMap[t.ratingKey] = {
          ratingKey:    t.ratingKey,
          title:        t.title,
          artist:       artistName,
          album:        t.parentTitle || "",
          playCount:    plays,
          durationMs,
          thumb:        t.parentThumb || t.thumb || null,
          lastPlayedAt: t.lastViewedAt || 0,
        };
      }

      // Artista
      if (!artistAgg[artistKey]) {
        artistAgg[artistKey] = {
          artistKey,
          artist:    artistName,
          playCount: 0,
          totalMs:   0,
          thumb:     artObj?.thumb || null,
          genres:    (artObj?.Genre || []).map((g) => g.tag),
        };
      }
      artistAgg[artistKey].playCount += plays;
      artistAgg[artistKey].totalMs   += plays * durationMs;

      // Gêneros (via artista — tags Plex)
      for (const genre of (artObj?.Genre || []).map((g) => g.tag)) {
        if (!genreAgg[genre]) genreAgg[genre] = { genre, playCount: 0, trackCount: 0 };
        genreAgg[genre].playCount  += plays;
        genreAgg[genre].trackCount += 1;
      }

      // Gêneros de análise (subgenre da IA — mais específico que a tag Plex)
      if (this.analysisCache) {
        const cached = this.analysisCache.get(String(t.ratingKey));
        const sg = cached?.analysis?.subgenre;
        const bg = cached?.analysis?.genre;
        const useSubgenre = sg && sg !== "unknown" && sg.toLowerCase() !== (bg ?? "").toLowerCase();
        // Para o ranking de gêneros: prefere subgênero (mais granular)
        const agKey = useSubgenre ? sg : (bg && bg !== "unknown" ? bg : null);
        if (agKey) {
          if (!analysisGenreAgg[agKey]) analysisGenreAgg[agKey] = { genre: agKey, playCount: 0, trackCount: 0 };
          analysisGenreAgg[agKey].playCount  += plays;
          analysisGenreAgg[agKey].trackCount += 1;
        }
        // Para o label do artista: usa genre amplo (mais confiável como rótulo)
        const artistGenreKey = (bg && bg !== "unknown") ? bg : (sg && sg !== "unknown" ? sg : null);
        if (artistGenreKey) {
          if (!artistSubgenres[artistKey]) artistSubgenres[artistKey] = {};
          artistSubgenres[artistKey][artistGenreKey] = (artistSubgenres[artistKey][artistGenreKey] || 0) + 1;
        }
        // Acumula subgênero separadamente (para o formato genre/subgenre)
        if (sg && sg !== "unknown") {
          if (!artistSgMap[artistKey]) artistSgMap[artistKey] = {};
          artistSgMap[artistKey][sg] = (artistSgMap[artistKey][sg] || 0) + 1;
        }
      }
    }

    // Totais para o card de summary (todos os tracks do período)
    const totalMs    = Object.values(trackMap).reduce((s, t) => s + t.durationMs * t.playCount, 0);
    const totalPlays = Object.values(trackMap).reduce((s, t) => s + t.playCount, 0);

    // Ordena e limita
    const topTracks = Object.values(trackMap)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 20)
      .map(({ durationMs, ratingKey, ...t }) => {
        const cached = this.analysisCache?.get(String(ratingKey));
        const sg = cached?.analysis?.subgenre;
        const bg = cached?.analysis?.genre;
        const useSubgenre = sg && sg !== "unknown" && sg.toLowerCase() !== (bg ?? "").toLowerCase();
        const agKey = useSubgenre ? sg : (bg && bg !== "unknown" ? bg : null);
        return {
          ...t,
          totalMinutes:  Math.round((durationMs * t.playCount) / 60000),
          analysisGenre: agKey ?? null,
        };
      });

    const topArtists = Object.values(artistAgg)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 20)
      .map(({ totalMs: ms, artistKey: ak, ...a }) => {
        // Combina como 'genre/subgenre' quando subgênero difere do genre
        const sgCounts  = artistSubgenres[ak];
        const topGenre  = sgCounts
          ? Object.entries(sgCounts).sort((x, y) => y[1] - x[1])[0]?.[0]
          : null;
        const sgDetail  = artistSgMap[ak];
        const topSg     = sgDetail
          ? Object.entries(sgDetail).sort((x, y) => y[1] - x[1])[0]?.[0]
          : null;
        const isDiff    = topSg && topGenre && topSg.toLowerCase() !== topGenre.toLowerCase();
        const label     = topGenre
          ? (isDiff ? `${topGenre}/${topSg}` : topGenre)
          : (topSg ?? null);
        return {
          ...a,
          totalMinutes:   Math.round(ms / 60000),
          analysisGenre:  label,
        };
      });

    const topGenres = Object.values(genreAgg)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 15);

    const topAnalysisGenres = Object.values(analysisGenreAgg)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 15);

    return {
      period,
      summary: {
        totalPlays,
        totalMinutes:  Math.round(totalMs / 60000),
        totalHours:    Math.round((totalMs / 3600000) * 10) / 10,
        uniqueTracks:  Object.keys(trackMap).length,
        uniqueArtists: Object.keys(artistAgg).length,
      },
      topTracks,
      topArtists,
      topGenres,
      topAnalysisGenres,
    };
  }

  /**
   * Busca artwork do Plex e retorna o stream para proxy.
   * Isso evita expor o PLEX_TOKEN nas URLs do browser.
   * @param {string} thumbPath — caminho relativo ex: /library/metadata/123/thumb/...
   */
  async getThumb(thumbPath) {
    const url = `${this.plexUrl}${thumbPath}`;
    return this.axios.get(url, {
      headers:      this._headers,
      responseType: "stream",
      timeout:      8000,
    });
  }
}
