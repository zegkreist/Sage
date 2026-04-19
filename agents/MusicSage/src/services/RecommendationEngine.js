/**
 * RecommendationEngine — gera recomendações de músicas/artistas
 * que NÃO estão na biblioteca do usuário.
 *
 * Combina:
 *  - Perfil da biblioteca (topGenres, mood, energia) via MusicAnalyzer
 *  - Histórico de favoritos via HistoryService
 *  - Pergunta ao Ollama por recomendações fora da biblioteca
 */
import { logger } from "../logger.js";
export class RecommendationEngine {
  /**
   * @param {{ allfather, libraryScanner, historyService, analyzer, lastFmService }} config
   */
  constructor({ allfather, libraryScanner, historyService, analyzer, lastFmService, analysisCache } = {}) {
    this.allfather = allfather;
    this.libraryScanner = libraryScanner;
    this.historyService = historyService;
    this.analyzer = analyzer;
    this.lastFmService = lastFmService;
    this.analysisCache = analysisCache || null;
  }

  /**
   * Retorna recomendações de artistas e músicas fora da biblioteca.
   * @param {{ limit?: number, genre?: string }} options
   * @returns {Promise<Array<{artist, genre, description, whyRecommended}>>}
   */
  async recommend({ limit = 10, genre = null } = {}) {
    logger.info("RECOMMEND", `recommend() chamado — limit=${limit}${genre ? `, genre=${genre}` : ''}`);
    try {
      const [favorites, favoriteTracks, profile] = await Promise.all([
        this.historyService.getFavoriteArtists(20),
        this.historyService.getFavoriteTracks(15),
        this._buildProfile(),
      ]);

      logger.debug("RECOMMEND", `Perfil: topGenres=[${(profile.topGenres||[]).join(", ")}], mood=${profile.dominantMood}, energy=${profile.avgEnergy}`);

      const existingArtists = this.libraryScanner.getArtistNames();
      const favoriteArtistText = favorites.map((f, i) => `${i + 1}. ${f.artist} (${f.playCount}x)`).join("\n");
      const favoriteTrackText  = favoriteTracks.slice(0, 12).map((t, i) => `${i + 1}. "${t.title}" — ${t.artist} (${t.playCount}x)`).join("\n");
      const topAnchorArtists   = favorites.slice(0, 3).map((f) => f.artist).join(", ");

      const audioProfile = this._buildAudioProfile();

      const prompt = this._buildRecommendationPrompt({
        limit,
        profile,
        favoriteArtistText,
        favoriteTrackText,
        topAnchorArtists,
        existingArtists: existingArtists.slice(0, 50),
        genre,
        audioProfile,
      });

      const t0 = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.7, maxTokens: 2000 });
      logger.debug("OLLAMA", `askForJSON respondeu em ${Date.now() - t0}ms`);

      const items = Array.isArray(raw) ? raw : (raw?.recommendations ?? []);

      // Normaliza: aceita tanto {why} (formato compacto) quanto {whyRecommended} (legado)
      const normalized = items.map(r => ({
        artist:          r.artist ?? r.name ?? '',
        genre:           r.genre  ?? r.g    ?? '',
        whyRecommended:  r.why    ?? r.whyRecommended ?? '',
      }));

      // Filtra artistas já na biblioteca (case-insensitive)
      const existingLower = new Set(existingArtists.map((a) => a.toLowerCase()));
      const filtered = normalized.filter(
        (r) => r.artist && !existingLower.has(r.artist.toLowerCase())
      );

      logger.info("RECOMMEND", `${filtered.length} recomendações geradas (${items.length - filtered.length} filtradas por já estarem na biblioteca)`);
      return filtered.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro ao gerar recomendações: ${err.message}`);
      return [];
    }
  }

  /**
   * Retorna recomendações focadas em artistas.
   * @param {{ limit?: number, genre?: string }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended}>>}
   */
  async recommendArtists({ limit = 10, genre = null } = {}) {
    const recs = await this.recommend({ limit: limit + 10, genre }); // pede extra para compensar filtro
    return recs.slice(0, limit);
  }

  /**
   * Retorna artistas semelhantes a um artista dado.
   * Combina Last.fm (candidatos scored) + Ollama (curadoria contextual).
   * @param {string} seedArtist — artista pivot
   * @param {{ limit?: number }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended, similarity, source}>>}
   */
  async similarTo(seedArtist, { limit = 10 } = {}) {
    logger.info("RECOMMEND", `similarTo() chamado — seed="${seedArtist}", limit=${limit}`);
    try {
      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower = new Set(existingArtists.map((a) => a.toLowerCase()));

      // 1. Last.fm: busca candidatos scored
      const [lastFmCandidates, seedTags] = this.lastFmService
        ? await Promise.all([
            this.lastFmService.getSimilarArtists(seedArtist, 30),
            this.lastFmService.getArtistTags(seedArtist),
          ])
        : [[], []];

      // 2. Filtra os que já estão na biblioteca
      const filtered = lastFmCandidates.filter(
        (c) => !existingLower.has(c.artist.toLowerCase())
      );

      // 3. Ollama: curadoria + explicação
      const prompt = this._buildSimilarPrompt({
        seedArtist,
        seedTags,
        candidates: filtered.slice(0, 20),
        limit,
        existingArtists: existingArtists.slice(0, 30),
      });

      const t0 = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens: 1500 });
      logger.debug("OLLAMA", `similarTo askForJSON respondeu em ${Date.now() - t0}ms`);

      const items = Array.isArray(raw) ? raw : [];
      const source = filtered.length > 0 ? "lastfm+ollama" : "ollama";

      const normalized = items
        .map((r) => ({
          artist:         r.artist ?? "",
          genre:          r.genre  ?? "",
          whyRecommended: r.why    ?? r.whyRecommended ?? "",
          similarity:     r.similarity ?? null,
          source,
        }))
        .filter((r) => r.artist && !existingLower.has(r.artist.toLowerCase()));

      logger.info("RECOMMEND", `similarTo("${seedArtist}"): ${normalized.length} resultados`);
      return normalized.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro em similarTo: ${err.message}`);
      return [];
    }
  }

  _buildSimilarPrompt({ seedArtist, seedTags, candidates, limit, existingArtists }) {
    const tagsText  = seedTags.length ? seedTags.join(", ") : "unknown";
    const libList   = existingArtists.join(", ");
    const candidateSection = candidates.length
      ? `Last.fm similar artists (use as inspiration): ${candidates.map((c) => `${c.artist} (similarity: ${c.similarity.toFixed(2)})`).join(", ")}`
      : `No Last.fm data available — use your knowledge of artists similar to "${seedArtist}".`;

    return `You are a music expert. The listener enjoys "${seedArtist}" (tags: ${tagsText}).
${candidateSection}

LIBRARY (do NOT recommend these): ${libList}

Recommend exactly ${limit} artists similar to "${seedArtist}" that are NOT in the library.
Return a JSON array:
[{"artist":"...", "genre":"...", "why":"one sentence why a fan of ${seedArtist} would enjoy them"}]
Return ONLY the JSON array.`;
  }

  /**
   * Retorna artistas DENTRO da biblioteca que são similares a um artista dado.
   * Inverte o filtro do similarTo(): mantém apenas artistas já na coleção.
   * @param {string} seedArtist
   * @param {{ limit?: number }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended, similarity, source, inLibrary}>>}
   */
  async similarInLibrary(seedArtist, { limit = 10 } = {}) {
    logger.info("RECOMMEND", `similarInLibrary() chamado — seed="${seedArtist}", limit=${limit}`);
    try {
      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower = new Set(existingArtists.map((a) => a.toLowerCase()));

      // 1. Last.fm: busca candidatos → mantém APENAS os que estão na biblioteca
      const [lastFmCandidates, seedTags] = this.lastFmService
        ? await Promise.all([
            this.lastFmService.getSimilarArtists(seedArtist, 50),
            this.lastFmService.getArtistTags(seedArtist),
          ])
        : [[], []];

      const inLibrary = lastFmCandidates.filter((c) => existingLower.has(c.artist.toLowerCase()));

      // 2. Ollama: escolhe da biblioteca com contexto Last.fm
      const tagsText   = seedTags.length ? seedTags.join(", ") : "unknown";
      const libList    = existingArtists.slice(0, 60).join(", ");
      const lastFmHint = inLibrary.length
        ? `Last.fm confirmed these library artists are similar: ${inLibrary.map((c) => c.artist).join(", ")}.`
        : `Last.fm found no direct library matches — use your musical knowledge.`;

      const prompt = `You are a music expert. The listener wants artists already in their library that are similar to "${seedArtist}" (tags: ${tagsText}).
${lastFmHint}
LIBRARY — choose artists ONLY from this list: ${libList}

Select exactly ${limit} artists from the library that are most similar to "${seedArtist}" in sound, style, or mood.
Return a JSON array:
[{"artist":"...", "genre":"...", "why":"one sentence why a fan of ${seedArtist} would enjoy them"}]
Return ONLY the JSON array.`;

      const t0 = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens: 1000 });
      logger.debug("OLLAMA", `similarInLibrary askForJSON respondeu em ${Date.now() - t0}ms`);

      const items  = Array.isArray(raw) ? raw : [];
      const source = inLibrary.length > 0 ? "lastfm+ollama" : "ollama";

      const normalized = items
        .map((r) => ({
          artist:         r.artist ?? "",
          genre:          r.genre  ?? "",
          whyRecommended: r.why    ?? r.whyRecommended ?? "",
          similarity:     r.similarity ?? null,
          source,
          inLibrary: true,
        }))
        .filter((r) => r.artist && existingLower.has(r.artist.toLowerCase()));

      logger.info("RECOMMEND", `similarInLibrary("${seedArtist}"): ${normalized.length} resultados na biblioteca`);
      return normalized.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro em similarInLibrary: ${err.message}`);
      return [];
    }
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  _buildAudioProfile() {
    if (!this.analysisCache) return null;
    const entries = this.analysisCache.getAll();
    if (!entries?.length) return null;

    const numerics = ["energy", "valence", "danceability", "acousticness", "bpm"];
    const sums     = Object.fromEntries(numerics.map((k) => [k, 0]));
    const counts   = Object.fromEntries(numerics.map((k) => [k, 0]));
    const genreFreq = {}, subgenreFreq = {}, moodFreq = {}, eraFreq = {};

    for (const e of entries) {
      const a = e.analysis;
      if (!a) continue;
      for (const k of numerics) {
        if (typeof a[k] === "number") { sums[k] += a[k]; counts[k]++; }
      }
      if (a.genre)    genreFreq[a.genre]       = (genreFreq[a.genre]       || 0) + 1;
      if (a.subgenre) subgenreFreq[a.subgenre] = (subgenreFreq[a.subgenre] || 0) + 1;
      if (a.mood)     moodFreq[a.mood]         = (moodFreq[a.mood]         || 0) + 1;
      if (a.era)      eraFreq[a.era]           = (eraFreq[a.era]           || 0) + 1;
    }

    const topN = (freq, n = 5) => Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const avg  = (k) => counts[k] ? +(sums[k] / counts[k]).toFixed(1) : null;

    return {
      totalTracks:     entries.length,
      avgEnergy:       avg("energy"),
      avgValence:      avg("valence"),
      avgDanceability: avg("danceability"),
      avgAcousticness: avg("acousticness"),
      avgBpm:          counts.bpm ? +(sums.bpm / counts.bpm).toFixed(0) : null,
      topGenres:       topN(genreFreq),
      topSubgenres:    topN(subgenreFreq),
      topMoods:        topN(moodFreq),
      topEras:         topN(eraFreq),
    };
  }

  async _buildProfile() {
    const artists = this.libraryScanner.getArtistsWithGenres().slice(0, 50);
    return this.analyzer.buildLibraryProfile(artists);
  }

  _buildRecommendationPrompt({ limit, profile, favoriteArtistText, favoriteTrackText, topAnchorArtists, existingArtists, genre, audioProfile }) {
    const genreText    = genre ? genre : (profile.topGenres || []).slice(0, 5).join(", ") || "various";
    const libraryList  = existingArtists.join(", ");
    const genreClause  = genre
      ? `Focus specifically on ${genre} genre artists.`
      : `Prioritize artists whose style matches the genres: ${genreText}.`;
    const anchorClause = topAnchorArtists
      ? `The listener's absolute favorites are: ${topAnchorArtists}. Recommendations MUST appeal to fans of these artists.`
      : "";
    const moodClause   = profile.dominantMood
      ? `Overall library mood: ${profile.dominantMood}, energy level: ${profile.avgEnergy || 5}/10.`
      : "";

    let audioSection = "";
    if (audioProfile) {
      const parts = [];
      if (audioProfile.avgEnergy        != null) parts.push(`• Energia média: ${audioProfile.avgEnergy}/10`);
      if (audioProfile.avgValence       != null) parts.push(`• Valência (positividade) média: ${audioProfile.avgValence}/10`);
      if (audioProfile.avgDanceability  != null) parts.push(`• Dançabilidade média: ${audioProfile.avgDanceability}/10`);
      if (audioProfile.avgBpm           != null) parts.push(`• BPM médio: ${audioProfile.avgBpm}`);
      if (audioProfile.topGenres?.length)        parts.push(`• Top géneros: ${audioProfile.topGenres.join(", ")}`);
      if (audioProfile.topSubgenres?.length)     parts.push(`• Top subgéneros: ${audioProfile.topSubgenres.join(", ")}`);
      if (audioProfile.topMoods?.length)         parts.push(`• Top humores: ${audioProfile.topMoods.join(", ")}`);
      if (audioProfile.topEras?.length)          parts.push(`• Eras predominantes: ${audioProfile.topEras.join(", ")}`);
      if (parts.length) {
        audioSection = `\nANÁLISE DE ÁUDIO DA BIBLIOTECA (${audioProfile.totalTracks} faixas analisadas — use para refinar recomendações):\n${parts.join("\n")}\n`;
      }
    }

    return `You are a music recommendation expert.

The listener's MOST PLAYED ARTISTS (primary signal — use this as the main basis):
${favoriteArtistText || "(no data)"}

The listener's MOST PLAYED TRACKS (use to understand style and taste):
${favoriteTrackText || "(no data)"}
${audioSection}
${anchorClause}
${moodClause}
${genreClause}

Based primarily on the most played artists and tracks above, recommend exactly ${limit} NEW artists that:
- Sound similar to or are frequently enjoyed alongside the top played artists
- Are NOT already in the listener's library
- Each recommendation should feel like a natural next step from the actual listening data

LIBRARY — do NOT recommend any of these: ${libraryList}

Return a JSON array of exactly ${limit} items:
[{"artist":"...", "genre":"...", "why":"one sentence specifically referencing which of the listener's favorites this is similar to"}]

Return ONLY the JSON array.`;
  }
}
