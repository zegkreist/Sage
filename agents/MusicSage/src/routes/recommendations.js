/**
 * GET /api/recommendations          → recommend({ limit })
 * GET /api/recommendations/artists   → recommendArtists({ limit })
 * GET /api/recommendations/similar   → similarTo(artist, { limit })
 * GET /api/recommendations/similar-in-library → similarInLibrary(artist, { limit })
 */
export function recommendationsRouter(router, { recommendationEngine }) {
  router.get("/recommendations/artists", async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 10;
    try {
      const recs = await recommendationEngine.recommendArtists({ limit });
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/recommendations/similar", async (req, res) => {
    const artist = req.query.artist?.trim();
    const limit  = parseInt(req.query.limit, 10) || 10;
    if (!artist) return res.status(400).json({ error: 'Parâmetro "artist" obrigatório' });
    try {
      const recs = await recommendationEngine.similarTo(artist, { limit });
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/recommendations/similar-in-library", async (req, res) => {
    const artist = req.query.artist?.trim();
    const limit  = parseInt(req.query.limit, 10) || 10;
    if (!artist) return res.status(400).json({ error: 'Parâmetro "artist" obrigatório' });
    try {
      const recs = await recommendationEngine.similarInLibrary(artist, { limit });
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/recommendations", async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 10;
    const genre = req.query.genre?.trim() || null;
    try {
      const recs = await recommendationEngine.recommend({ limit, genre });
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
