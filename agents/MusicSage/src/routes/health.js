/** GET /api/health */
export function healthRouter(router) {
  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "MusicSage",
      timestamp: new Date().toISOString(),
    });
  });
  return router;
}
