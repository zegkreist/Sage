/**
 * Rotas /api/embeddings
 *
 * POST  /api/embeddings/start          — inicia batch de geração de embeddings
 * POST  /api/embeddings/stop           — para o batch em execução
 * GET   /api/embeddings/status         — progresso + estatísticas
 * GET   /api/embeddings/clusters?k=8   — clusters com coordenadas 2D
 * POST  /api/embeddings/clusters/playlist — cria playlist a partir de um cluster
 * GET   /api/embeddings/similar/:ratingKey?limit=10 — faixas mais similares
 * DELETE /api/embeddings/reset         — apaga todos os embeddings armazenados
 */

export function embeddingsRouter(router, { embeddingService, clusteringService, playlistBuilder, analysisCache } = {}) {

  /**
   * POST /api/embeddings/start
   * Body: { force?: boolean }
   *   force=true → reprocessa faixas com embedding existente
   */
  router.post("/embeddings/start", async (req, res) => {
    if (!embeddingService) return res.status(503).json({ error: "EmbeddingService indisponível" });
    const { force = false } = req.body || {};
    try {
      await embeddingService.startBatch({ force });
      res.json({ started: true, status: embeddingService.getStatus() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/embeddings/stop
   */
  router.post("/embeddings/stop", (req, res) => {
    if (!embeddingService) return res.status(503).json({ error: "EmbeddingService indisponível" });
    embeddingService.stopBatch();
    res.json({ stopped: true });
  });

  /**
   * GET /api/embeddings/status
   */
  router.get("/embeddings/status", (req, res) => {
    if (!embeddingService) return res.status(503).json({ error: "EmbeddingService indisponível" });
    res.json(embeddingService.getStatus());
  });

  /**
   * GET /api/embeddings/clusters?k=8
   *     /api/embeddings/clusters?k=auto  ← Elbow Method escolhe k automaticamente
   *
   * Recalcula clusters em tempo real (PCA + k-means na memória).
   * Para bibliotecas grandes (>5000 faixas), a operação pode levar 2–5s.
   */
  router.get("/embeddings/clusters", (req, res) => {
    if (!embeddingService || !clusteringService) {
      return res.status(503).json({ error: "Serviços de embedding indisponíveis" });
    }
    const stored = embeddingService.getStored();
    const total  = Object.keys(stored).length;
    if (total < 2) {
      return res.status(400).json({ error: `São necessários pelo menos 2 embeddings (atual: ${total}). Execute o batch primeiro.` });
    }
    try {
      let result;
      if (req.query.k === "auto") {
        // Modo automático: Elbow Method escolhe o k ótimo
        result = clusteringService.clusterAuto(stored, 2, 15);
      } else {
        const k = Math.max(2, Math.min(20, parseInt(req.query.k) || 8));
        result = clusteringService.cluster(stored, k);
      }
      res.json({ ...result, totalEmbedded: total });
    } catch (err) {
      res.status(500).json({ error: "Falha na clusterização: " + err.message });
    }
  });

  /**
   * POST /api/embeddings/clusters/playlist
   * Body: { tracks: [{ratingKey, title, artist, album}], name?: string }
   *
   * Cria uma playlist a partir dos tracks de um cluster selecionado.
   */
  router.post("/embeddings/clusters/playlist", async (req, res) => {
    if (!playlistBuilder) return res.status(503).json({ error: "PlaylistBuilder indisponível" });
    const { tracks, name } = req.body || {};
    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(400).json({ error: "Campo 'tracks' é obrigatório (array não-vazio)" });
    }
    try {
      // Monta o formato esperado pelo PlaylistBuilder
      const plTracks = tracks.map((t) => ({
        ratingKey: t.ratingKey,
        title:     t.title  || "Faixa",
        artist:    t.artist || "",
        album:     t.album  || "",
      }));
      const playlistName = name || `Cluster — ${new Date().toLocaleDateString("pt-BR")}`;
      const pl = await playlistBuilder.save({ name: playlistName, tracks: plTracks });
      res.status(201).json(pl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/embeddings/similar/:ratingKey?limit=10
   */
  router.get("/embeddings/similar/:ratingKey", (req, res) => {
    if (!embeddingService) return res.status(503).json({ error: "EmbeddingService indisponível" });
    const { ratingKey } = req.params;
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 10));
    const result = embeddingService.getSimilarTracks(ratingKey, limit);
    if (!result.length && !embeddingService.getOne(ratingKey)) {
      return res.status(404).json({ error: `Faixa ${ratingKey} não possui embedding armazenado` });
    }
    res.json(result);
  });

  /**
   * DELETE /api/embeddings/reset
   * Apaga todos os embeddings armazenados (irreversível).
   */
  router.delete("/embeddings/reset", (req, res) => {
    if (!embeddingService) return res.status(503).json({ error: "EmbeddingService indisponível" });
    if (embeddingService.getStatus().running) {
      return res.status(409).json({ error: "Não é possível resetar enquanto o batch está em execução" });
    }
    embeddingService.reset();
    res.json({ reset: true });
  });

  /**
   * GET /api/embeddings/clusters-by-analysis?k=8
   *
   * Agrupa faixas por similaridade de áudio (energy, valence, danceability,
   * acousticness, complexity, bpm) sem usar embeddings vetoriais.
   * Não requer batch de embeddings — usa apenas o analysis-cache.json.
   */
  router.get("/embeddings/clusters-by-analysis", (req, res) => {
    if (!clusteringService) {
      return res.status(503).json({ error: "ClusteringService indisponível" });
    }
    if (!analysisCache) {
      return res.status(503).json({ error: "AnalysisCache indisponível" });
    }
    const entries = analysisCache.getAll();
    const analyzed = entries.filter((e) => e.analysis);
    if (analyzed.length < 2) {
      return res.status(400).json({
        error: `São necessárias pelo menos 2 faixas analisadas (atual: ${analyzed.length}). Execute o batch de análise primeiro.`,
      });
    }
    try {
      let result;
      if (req.query.k === 'auto') {
        result = clusteringService.clusterByAnalysisAuto(analyzed);
      } else {
        const k = Math.max(2, Math.min(20, parseInt(req.query.k) || 8));
        result = clusteringService.clusterByAnalysis(analyzed, k);
      }
      res.json({ ...result, totalAnalyzed: analyzed.length });
    } catch (err) {
      res.status(500).json({ error: "Falha na clusterização por áudio: " + err.message });
    }
  });
}
