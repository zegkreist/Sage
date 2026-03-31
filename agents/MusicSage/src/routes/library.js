/** GET /api/library/stats */
export function libraryRouter(router, { libraryScanner }) {
  router.get("/library/stats", (_req, res) => {
    const stats = libraryScanner.getLibraryStats();
    res.json(stats);
  });
  return router;
}
