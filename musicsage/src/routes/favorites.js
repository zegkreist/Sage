/**
 * GET    /api/favorites                       — lista todos os favoritos
 * PUT    /api/favorites                       — cria/atualiza { artist, title, album, starred?, rating? }
 * DELETE /api/favorites?artist=&title=&album= — remove
 */
export function favoritesRouter(router, { favoritesService } = {}) {
  router.get("/favorites", (_req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    res.json({ favorites: favoritesService.list() });
  });

  router.put("/favorites", (req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    const { artist, title, album, starred, rating } = req.body || {};
    if (!title && !artist) return res.status(400).json({ error: "Informe ao menos 'title' ou 'artist'" });
    if (rating != null && (typeof rating !== "number" || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: "'rating' deve ser número entre 0 e 5 (ou null)" });
    }
    const entry = favoritesService.setFavorite(
      { artist: (artist || "").trim(), title: (title || "").trim(), album: (album || "").trim() },
      { starred, rating: rating === undefined ? undefined : rating }
    );
    res.json({ favorite: entry });
  });

  router.delete("/favorites", (req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    const { artist = "", title = "", album = "" } = req.query;
    const removed = favoritesService.remove(
      String(artist).trim(), String(title).trim(), String(album).trim()
    );
    if (!removed) return res.status(404).json({ error: "Favorito não encontrado" });
    res.json({ ok: true });
  });
}
