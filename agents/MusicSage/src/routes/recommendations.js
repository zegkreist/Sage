/**
 * GET /api/recommendations          → recommend({ limit })
 * GET /api/recommendations/artists   → recommendArtists({ limit })
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

  router.get("/recommendations", async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 10;
    try {
      const recs = await recommendationEngine.recommend({ limit });
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
