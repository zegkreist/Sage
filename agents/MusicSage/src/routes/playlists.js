/**
 * POST   /api/playlists/generate     → gera nova playlist por critérios
 * POST   /api/playlists/from-prompt  → gera playlist a partir de texto livre
 * GET    /api/playlists              → lista playlists salvas
 * GET    /api/playlists/:id          → retorna playlist específica
 * PATCH  /api/playlists/:id          → atualiza nome e/ou faixas
 * DELETE /api/playlists/:id          → remove playlist
 */
export function playlistsRouter(router, { playlistBuilder }) {
  // POST /api/playlists/generate
  router.post("/playlists/generate", async (req, res) => {
    const { name, mood, genre, energy, size } = req.body || {};
    try {
      const playlist = await playlistBuilder.generate({
        name,
        mood,
        genre,
        energy,
        size: size ? parseInt(size, 10) : 10,
      });
      res.status(201).json(playlist);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/playlists
  router.get("/playlists", (_req, res) => {
    res.json(playlistBuilder.list());
  });

  // GET /api/playlists/:id
  router.get("/playlists/:id", (req, res) => {
    const playlist = playlistBuilder.get(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist não encontrada" });
    res.json(playlist);
  });

  // POST /api/playlists/from-prompt
  router.post("/playlists/from-prompt", async (req, res) => {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Campo 'prompt' é obrigatório" });
    }
    try {
      const playlist = await playlistBuilder.generateFromPrompt(prompt.trim());
      res.status(201).json(playlist);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/playlists/:id
  router.patch("/playlists/:id", (req, res) => {
    const { name, tracks } = req.body || {};
    if (name === undefined && tracks === undefined) {
      return res.status(400).json({ error: "Informe ao menos 'name' ou 'tracks' para atualizar" });
    }
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (tracks !== undefined) fields.tracks = tracks;
    const updated = playlistBuilder.update(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: "Playlist não encontrada" });
    res.json(updated);
  });

  // DELETE /api/playlists/:id
  router.delete("/playlists/:id", (req, res) => {
    const deleted = playlistBuilder.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Playlist não encontrada" });
    res.status(204).send();
  });

  return router;
}
