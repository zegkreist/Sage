/** GET /api/library/stats
 *  GET /api/library/history  — artistas e faixas mais ouvidas
 *  GET /api/library/metrics  — retrospectiva por período (week|month|year)
 *  GET /api/library/users    — lista de usuários/contas Plex
 *  GET /api/library/thumb    — proxy de artwork do Plex (evita expor PLEX_TOKEN)
 *  GET /api/library/tracks   — lista resumida de todas as faixas (para autocomplete)
 *  GET /api/library/recently-played — histórico recente com ratingKey
 *  GET /api/library/mood     — mood do período (day|month) calculado via analysisCache
 *  GET /api/library/curiosidades — fatos curiosos sobre a biblioteca
 */
export function libraryRouter(router, { libraryScanner, historyService, metricsService, audioAnalyzer, analysisCache, playlistBuilder, plexService }) {
  router.get("/library/stats", (_req, res) => {
    const stats = libraryScanner.getLibraryStats();
    const totalPlaylists = playlistBuilder ? playlistBuilder.list().length : 0;
    res.json({ ...stats, totalPlaylists });
  });

  /**
   * GET /api/library/tracks
   * Retorna lista resumida de todas as faixas para uso em autocomplete.
   * Response: { tracks: [{ ratingKey, title, artist, album, filePath }] }
   */
  router.get("/library/tracks", async (_req, res) => {
    try {
      const { tracks } = await libraryScanner.scan();
      const summary = tracks.map(t => {
        const plexPath = t.Media?.[0]?.Part?.[0]?.file || "";
        const filePath = audioAnalyzer ? audioAnalyzer._resolvePath(plexPath) || plexPath : plexPath;
        return {
          ratingKey: t.ratingKey,
          title:     t.title            || "",
          artist:    t.grandparentTitle || "",
          album:     t.parentTitle      || "",
          filePath,
        };
      });
      res.json({ tracks: summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/library/history", async (_req, res) => {
    try {
      const [artists, tracks] = await Promise.all([
        historyService.getFavoriteArtists(10),
        historyService.getFavoriteTracks(10),
      ]);
      res.json({ artists, tracks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/library/metrics", async (req, res) => {
    if (!metricsService) return res.status(503).json({ error: "MetricsService não disponível" });
    const allowed = ["week", "month", "year"];
    const period  = allowed.includes(req.query.period) ? req.query.period : "month";
    const userId  = req.query.userId ? parseInt(req.query.userId, 10) || null : null;
    try {
      const data = await metricsService.getMetrics(period, userId);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/library/users", async (_req, res) => {
    if (!plexService) return res.status(503).json({ error: "PlexService não disponível" });
    try {
      const users = await plexService.getUsers();
      res.json({ users });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/library/thumb", async (req, res) => {
    if (!metricsService) return res.status(503).json({ error: "MetricsService não disponível" });
    const thumbPath = req.query.path || "";
    // Permite apenas caminhos de metadata do Plex para evitar SSRF
    if (!/^\/library\/[a-z0-9/._-]+$/i.test(thumbPath)) {
      return res.status(400).json({ error: "Invalid thumb path" });
    }
    try {
      const response = await metricsService.getThumb(thumbPath);
      const ct = response.headers["content-type"] || "image/jpeg";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=86400");
      response.data.pipe(res);
    } catch {
      res.status(204).end();
    }
  });

  // ── Novos endpoints para página Insights ──────────────────────────────────

  /**
   * GET /api/library/recently-played?limit=50
   * Faixas ordenadas por última reprodução, com ratingKey para cross-ref.
   */
  router.get("/library/recently-played", async (req, res) => {
    if (!historyService) return res.status(503).json({ error: "HistoryService indisponível" });
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    try {
      const tracks = await historyService.getRecentlyPlayedFull(limit);
      res.json({ tracks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/library/mood?period=day|month
   * Computa mood a partir das faixas tocadas no período, cruzando com analysisCache.
   * Não usa LLM — matemática pura sobre os campos de análise.
   */
  router.get("/library/mood", async (req, res) => {
    if (!historyService) return res.status(503).json({ error: "HistoryService indisponível" });
    if (!analysisCache)  return res.status(503).json({ error: "AnalysisCache indisponível" });

    const allowed = ["day", "month"];
    const period  = allowed.includes(req.query.period) ? req.query.period : "day";

    // Limiar de tempo: agora − período
    const nowTs  = Math.floor(Date.now() / 1000);
    const fromTs = period === "day"
      ? nowTs - 86400          // últimas 24h
      : nowTs - 86400 * 30;   // últimos 30 dias

    try {
      const played  = await historyService.getPlayedSince(fromTs, 500);
      if (!played.length) {
        return res.json({ period, tracksAnalyzed: 0, moodLabel: "Sem dados", topMoods: [], topGenres: [], avgEnergy: null, avgValence: null, avgDanceability: null, avgBpm: null, artistOfPeriod: null });
      }

      // Cross-ref com analysisCache
      const withAnalysis = played
        .map((t) => ({ ...t, analysis: analysisCache.getAnalysis(t.ratingKey) }))
        .filter((t) => t.analysis);

      if (!withAnalysis.length) {
        // Sem análise mas há plays — retorna dados mínimos
        const artistCounts = {};
        for (const t of played) artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
        const artistOfPeriod = Object.entries(artistCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return res.json({ period, tracksAnalyzed: 0, moodLabel: "Sem análise", topMoods: [], topGenres: [], avgEnergy: null, avgValence: null, avgDanceability: null, avgBpm: null, artistOfPeriod });
      }

      // Médias dos campos numéricos
      const avg = (field) => {
        const vals = withAnalysis.map((t) => t.analysis[field]).filter((v) => typeof v === "number");
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
      };
      const avgEnergy       = avg("energy");
      const avgValence      = avg("valence");
      const avgDanceability = avg("danceability");
      const avgBpm          = avg("bpm") ? Math.round(avg("bpm")) : null;

      // Top moods e géneros (frequência)
      const moodCount  = {};
      const genreCount = {};
      const artistCount = {};
      for (const t of withAnalysis) {
        const a = t.analysis;
        if (a.mood)   moodCount[a.mood]   = (moodCount[a.mood]   || 0) + 1;
        if (a.genre)  genreCount[a.genre] = (genreCount[a.genre] || 0) + 1;
        if (t.artist) artistCount[t.artist] = (artistCount[t.artist] || 0) + 1;
      }
      const topMoods   = Object.entries(moodCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m]) => m);
      const topGenres  = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
      const artistOfPeriod = Object.entries(artistCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      // Derivar moodLabel a partir de energia e valência
      const moodLabel = _deriveMoodLabel(avgEnergy, avgValence, avgDanceability, topMoods[0]);

      res.json({
        period,
        tracksAnalyzed: withAnalysis.length,
        totalPlayed: played.length,
        moodLabel,
        topMoods,
        topGenres,
        avgEnergy,
        avgValence,
        avgDanceability,
        avgBpm,
        artistOfPeriod,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/library/curiosidades
   * Computa ~10 fatos curiosos sobre a biblioteca a partir do analysisCache + libraryScanner.
   */
  router.get("/library/curiosidades", async (req, res) => {
    if (!analysisCache) return res.status(503).json({ error: "AnalysisCache indisponível" });
    try {
      const entries  = analysisCache.getAll().filter((e) => e.analysis);
      const stats    = libraryScanner.getLibraryStats();
      const facts    = [];

      if (entries.length < 5) {
        return res.json({ facts: [{ icon: "🔬", text: "Analise mais faixas para ver curiosidades!" }] });
      }

      const n = entries.length;

      // Energéticas
      const highEnergy = entries.filter((e) => (e.analysis.energy ?? 0) >= 7).length;
      facts.push({ icon: "⚡", text: `${Math.round(highEnergy / n * 100)}% das suas faixas têm alta energia (≥7/10)` });

      // Mais dançante
      const mostDance = entries.reduce((a, b) => (b.analysis.danceability ?? 0) > (a.analysis.danceability ?? 0) ? b : a);
      facts.push({ icon: "💃", text: `Faixa mais dançante: "${mostDance.title}" — ${mostDance.artist}` });

      // Mais energética
      const mostEnergetic = entries.reduce((a, b) => (b.analysis.energy ?? 0) > (a.analysis.energy ?? 0) ? b : a);
      facts.push({ icon: "🔥", text: `Faixa mais energética: "${mostEnergetic.title}" — ${mostEnergetic.artist}` });

      // Mais calma
      const calmest = entries.reduce((a, b) => (b.analysis.energy ?? 10) < (a.analysis.energy ?? 10) ? b : a);
      facts.push({ icon: "🌊", text: `Faixa mais tranquila: "${calmest.title}" — ${calmest.artist}` });

      // BPM médio
      const bpms = entries.map((e) => e.analysis.bpm).filter((b) => typeof b === "number" && b > 0);
      if (bpms.length) {
        const avgBpm = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);
        facts.push({ icon: "🥁", text: `BPM médio da biblioteca: ${avgBpm} bpm` });
      }

      // Era dominante
      const eraCounts = {};
      for (const e of entries) if (e.analysis.era) eraCounts[e.analysis.era] = (eraCounts[e.analysis.era] || 0) + 1;
      const topEra = Object.entries(eraCounts).sort((a, b) => b[1] - a[1])[0];
      if (topEra) facts.push({ icon: "📅", text: `Era dominante na sua biblioteca: ${topEra[0]}` });

      // Acústicas
      const acoustic = entries.filter((e) => (e.analysis.acousticness ?? 0) >= 7).length;
      facts.push({ icon: "🎸", text: `${Math.round(acoustic / n * 100)}% das faixas são predominantemente acústicas` });

      // Gênero mais comum
      const genreMap = {};
      for (const e of entries) if (e.analysis.genre) genreMap[e.analysis.genre] = (genreMap[e.analysis.genre] || 0) + 1;
      const topGenre = Object.entries(genreMap).sort((a, b) => b[1] - a[1])[0];
      if (topGenre) facts.push({ icon: "🎵", text: `Gênero dominante: ${topGenre[0]} (${topGenre[1]} faixas analisadas)` });

      // Mood mais frequente
      const moodMap = {};
      for (const e of entries) if (e.analysis.mood) moodMap[e.analysis.mood] = (moodMap[e.analysis.mood] || 0) + 1;
      const topMood = Object.entries(moodMap).sort((a, b) => b[1] - a[1])[0];
      if (topMood) facts.push({ icon: "🎭", text: `Mood mais frequente na biblioteca: "${topMood[0]}"` });

      // Cobertura de análise
      const coverage = Math.round(n / stats.totalTracks * 100);
      facts.push({ icon: "🔬", text: `${n} de ${stats.totalTracks} faixas analisadas (${coverage}% de cobertura)` });

      // Faixa com mais complexidade
      const mostComplex = entries.reduce((a, b) => (b.analysis.complexity ?? 0) > (a.analysis.complexity ?? 0) ? b : a);
      facts.push({ icon: "🧩", text: `Faixa mais complexa: "${mostComplex.title}" — ${mostComplex.artist}` });

      res.json({ facts, totalAnalyzed: n, totalTracks: stats.totalTracks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ── Helper: deriva um label de mood a partir dos valores médios ─────────────

function _deriveMoodLabel(energy, valence, danceability, topMood) {
  if (energy === null && valence === null) return topMood || "Indefinido";

  const e = energy   ?? 5;
  const v = valence  ?? 5;
  const d = danceability ?? 5;

  if (e >= 7 && v >= 6 && d >= 6) return "Animado 🎉";
  if (e >= 7 && v >= 6)           return "Energético 🔥";
  if (e >= 7 && v < 4)            return "Intenso ⚡";
  if (e >= 6 && v >= 6 && d >= 6) return "Dançante 💃";
  if (e < 4 && v >= 6)            return "Contemplativo 🌤";
  if (e < 4 && v < 4)             return "Melancólico 💙";
  if (e < 4)                      return "Relaxado 🌊";
  if (v >= 7)                     return "Positivo ☀️";
  if (v < 3)                      return "Sombrio 🌑";
  return topMood || "Equilibrado 🎵";
}
