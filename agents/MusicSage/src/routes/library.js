/** GET /api/library/stats
 *  GET /api/library/history  — artistas e faixas mais ouvidas
 *  GET /api/library/metrics  — retrospectiva por período (week|month|year)
 *  GET /api/library/thumb    — proxy de artwork do Plex (evita expor PLEX_TOKEN)
 *  GET /api/library/tracks   — lista resumida de todas as faixas (para autocomplete)
 */
export function libraryRouter(router, { libraryScanner, historyService, metricsService, audioAnalyzer }) {
  router.get("/library/stats", (_req, res) => {
    const stats = libraryScanner.getLibraryStats();
    res.json(stats);
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
    try {
      const data = await metricsService.getMetrics(period);
      res.json(data);
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

  return router;
}
