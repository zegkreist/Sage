/**
 * Rotas de análise de áudio nativa via gemma4 + Ollama
 *
 *   POST /api/audio/analyze         — analisa um arquivo de áudio
 *   POST /api/audio/embed           — analisa + gera embedding vetorial
 *   POST /api/audio/playlist        — analisa referência + monta playlist similar
 *   POST /api/audio/batch-analyze   — inicia análise em lote de toda a biblioteca
 *   GET  /api/audio/batch-progress  — progresso da análise em lote
 *   GET  /api/audio/analysis-cache  — retorna cache de análises
 */

import { existsSync } from "fs";
import { logger } from "../logger.js";

/** Estado global do job de análise em lote (um por vez por instância do servidor) */
const batchJob = {
  running:   false,
  total:     0,
  done:      0,
  failed:    0,
  startedAt: null,
  aborted:   false,
};

/**
 * @param {import('express').Router} router
 * @param {{ analyzer, embeddingService, audioAnalyzer, playlistBuilder, plexService, analysisCache, libraryScanner }} deps
 */
export function audioRouter(router, { analyzer, embeddingService, audioAnalyzer, playlistBuilder, plexService, analysisCache, libraryScanner } = {}) {

  /**
   * POST /api/audio/analyze
   *
   * Analisa um arquivo de áudio usando gemma4 via Ollama.
   * Retorna gênero, mood, energia, timbre, instrumentos, etc. detectados no áudio real.
   *
   * Body:
   *   filePath      {string}   — caminho absoluto do arquivo de áudio no servidor
   *   plexFilePath  {string}   — alternativa: path Plex (ex: "/music/1/track.flac")
   *                              resolvido pelo AudioAnalyzerService
   *   title         {string?}  — título opcional para enriquecer o prompt
   *   artist        {string?}
   *   album         {string?}
   *   genres        {string[]?}
   *   maxAudioSecs  {number?}  — máximo de segundos de áudio (padrão: 30)
   *
   * Response 200: { analysis }
   */
  router.post("/audio/analyze", async (req, res) => {
    try {
      let { filePath, plexFilePath, title, artist, album, genres, maxAudioSecs } = req.body;

      // Resolve path Plex → path local se necessário
      if (!filePath && plexFilePath) {
        if (!audioAnalyzer) {
          return res.status(503).json({ error: "AudioAnalyzerService não disponível" });
        }
        filePath = audioAnalyzer._resolvePath(plexFilePath);
      }

      if (!filePath) {
        return res.status(400).json({ error: "filePath ou plexFilePath obrigatório" });
      }

      if (!existsSync(filePath)) {
        return res.status(404).json({ error: `Arquivo não encontrado: ${filePath}` });
      }

      if (!analyzer) {
        return res.status(503).json({ error: "MusicAnalyzer não disponível" });
      }

      logger.info("AUDIO", `Analisando: ${filePath}`);

      const analysis = await analyzer.analyzeAudioFile(
        filePath,
        { title, artist, album, genres },
        { maxAudioSecs: maxAudioSecs ?? 30 }
      );

      res.json({ analysis, filePath });
    } catch (err) {
      logger.error("AUDIO", "Falha em /audio/analyze", { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/audio/embed
   *
   * Analisa um arquivo de áudio via gemma4 e gera/atualiza o embedding vetorial
   * da faixa no EmbeddingService. O embedding reflete o conteúdo sonoro real,
   * não apenas os metadados do Plex.
   *
   * Body:
   *   ratingKey     {string}   — chave da faixa no Plex (usado como ID no store)
   *   filePath      {string}   — caminho absoluto do arquivo de áudio
   *   plexFilePath  {string}   — alternativa: path Plex
   *   title         {string?}
   *   artist        {string?}
   *   album         {string?}
   *   genres        {string[]?}
   *   maxAudioSecs  {number?}
   *
   * Response 200: { ratingKey, description, analysis, embeddingDim }
   */
  router.post("/audio/embed", async (req, res) => {
    try {
      let { ratingKey, filePath, plexFilePath, title, artist, album, genres, maxAudioSecs } = req.body;

      if (!ratingKey) {
        return res.status(400).json({ error: "ratingKey obrigatório" });
      }

      // Resolve path Plex → path local se necessário
      if (!filePath && plexFilePath) {
        if (!audioAnalyzer) {
          return res.status(503).json({ error: "AudioAnalyzerService não disponível" });
        }
        filePath = audioAnalyzer._resolvePath(plexFilePath);
      }

      if (!filePath) {
        return res.status(400).json({ error: "filePath ou plexFilePath obrigatório" });
      }

      if (!existsSync(filePath)) {
        return res.status(404).json({ error: `Arquivo não encontrado: ${filePath}` });
      }

      if (!analyzer || !embeddingService) {
        return res.status(503).json({ error: "MusicAnalyzer ou EmbeddingService não disponível" });
      }

      logger.info("AUDIO", `Gerando embedding por áudio: ${filePath} (ratingKey=${ratingKey})`);

      const track = { title, artist, album, genres: genres || [] };
      const result = await embeddingService.embedTrackWithAudio(
        track,
        filePath,
        ratingKey,
        analyzer,
        { maxAudioSecs: maxAudioSecs ?? 30 }
      );

      res.json({
        ratingKey,
        description:  result.description,
        analysis:     result.analysis,
        embeddingDim: result.embedding.length,
      });
    } catch (err) {
      logger.error("AUDIO", "Falha em /audio/embed", { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/audio/playlist
   *
   * Analisa o áudio de uma faixa de referência via gemma4 e monta uma playlist
   * com as faixas da biblioteca que soam mais similares — sem usar embeddings.
   *
   * O perfil sonoro (gênero, mood, energia, timbre, instrumentos, dinâmica,
   * vocal style, características) é extraído diretamente do áudio e usado como
   * critério de seleção para o Ollama percorrer a biblioteca.
   *
   * Body:
   *   filePath      {string}   — caminho absoluto do arquivo de referência
   *   title         {string?}  — título da faixa de referência (opcional)
   *   artist        {string?}
   *   album         {string?}
   *   genres        {string[]?}
   *   size          {number?}  — número de faixas na playlist (padrão: 10)
   *   name          {string?}  — nome da playlist (auto-gerado se omitido)
   *   maxAudioSecs  {number?}  — duração máxima do áudio analisado (padrão: 30)
   *   saveToPlex    {boolean?} — se true, salva no Plex depois de gerar
   *
   * Response 200: { playlist: { id, name, mood, genre, energy, tracks[], analysis, createdAt } }
   */
  router.post("/audio/playlist", async (req, res) => {
    try {
      const {
        filePath,
        title, artist, album, genres,
        size = 10,
        name,
        maxAudioSecs = 30,
        saveToPlex = false,
      } = req.body;

      if (!filePath) {
        return res.status(400).json({ error: "filePath obrigatório" });
      }
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: `Arquivo não encontrado: ${filePath}` });
      }
      if (!analyzer || !playlistBuilder) {
        return res.status(503).json({ error: "MusicAnalyzer ou PlaylistBuilder não disponível" });
      }

      logger.info("AUDIO", `Playlist por áudio: ${filePath} (size=${size})`);

      const playlist = await playlistBuilder.generateFromAudio(
        filePath,
        { size, name, maxAudioSecs, metaHint: { title, artist, album, genres } },
        analyzer,
      );

      // Salva no store interno
      const saved = playlistBuilder.save(playlist);

      // Sincroniza com Plex em background (não bloqueia) se saveToPlex e plexService disponível
      if (saveToPlex && plexService && saved) {
        plexService
          .createPlaylist(saved.name, saved.tracks.map(t => t.ratingKey))
          .then(({ plexId }) => playlistBuilder.update(saved.id, { plexId }))
          .catch(err => logger.warn("AUDIO", `Plex sync falhou: ${err.message}`));
      }

      res.json({ playlist: saved || playlist });
    } catch (err) {
      logger.error("AUDIO", "Falha em /audio/playlist", { err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/audio/analysis-cache ───────────────────────────────────────

  router.get("/audio/analysis-cache", (_req, res) => {
    if (!analysisCache) return res.status(503).json({ error: "AnalysisCacheService não disponível" });
    res.json(analysisCache.toJSON());
  });

  // ─── DELETE /api/audio/analysis-cache ────────────────────────────────────

  router.delete("/audio/analysis-cache", async (_req, res) => {
    if (!analysisCache) return res.status(503).json({ error: "AnalysisCacheService não disponível" });
    if (batchJob.running) return res.status(409).json({ error: "Análise em lote em andamento — cancele antes de limpar." });
    try {
      await analysisCache.clear();
      logger.info("AUDIO_ROUTE", "Cache de análises limpo via API");
      res.json({ ok: true, message: "Cache limpo com sucesso." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/audio/batch-progress ───────────────────────────────────────

  router.get("/audio/batch-progress", (_req, res) => {
    const pct = batchJob.total > 0 ? Math.round((batchJob.done + batchJob.failed) / batchJob.total * 100) : 0;
    res.json({ ...batchJob, pct });
  });

  // ─── POST /api/audio/batch-analyze ───────────────────────────────────────
  /**
   * Inicia análise em lote de todas as faixas da biblioteca.
   * As análises são salvas em AnalysisCacheService (arquivo JSON em disco).
   *
   * Body:
   *   maxAudioSecs  {number?}  — duração do trecho de áudio (padrão: 30)
   *   concurrency   {number?}  — análises paralelas (padrão: 1, máx: 3)
   *   skipExisting  {boolean?} — pula faixas que já estão no cache (padrão: true)
   *   abort         {boolean?} — se true, cancela o job em andamento
   */
  router.post("/audio/batch-analyze", async (req, res) => {
    if (!analyzer || !libraryScanner || !analysisCache) {
      return res.status(503).json({ error: "analyzer, libraryScanner ou analysisCache não disponível" });
    }

    const { abort, maxAudioSecs = 30, concurrency = 1, skipExisting = true } = req.body ?? {};

    if (abort) {
      batchJob.aborted = true;
      return res.json({ message: "Cancelamento solicitado", ...batchJob });
    }

    if (batchJob.running) {
      return res.status(409).json({ error: "Análise em lote já está em andamento", ...batchJob });
    }

    // Responde imediatamente — processamento ocorre em background
    res.json({ message: "Análise em lote iniciada", status: "running" });

    // ── executa em background ──────────────────────────────────────────────
    (async () => {
      batchJob.running   = true;
      batchJob.aborted   = false;
      batchJob.done      = 0;
      batchJob.failed    = 0;
      batchJob.startedAt = new Date().toISOString();

      try {
        await analysisCache.load();
        const { tracks } = await libraryScanner.scan();

        const todo = skipExisting
          ? tracks.filter(t => !analysisCache.has(String(t.ratingKey)))
          : tracks;

        batchJob.total = todo.length;
        logger.info("AUDIO_BATCH", `Iniciando análise de ${todo.length} faixas (skipExisting=${skipExisting})`);

        const cap = Math.min(Math.max(1, concurrency), 3);
        let idx   = 0;

        async function worker() {
          while (idx < todo.length && !batchJob.aborted) {
            const track = todo[idx++];
            const ratingKey  = String(track.ratingKey);
            const plexPath   = track.Media?.[0]?.Part?.[0]?.file;

            if (!plexPath) {
              batchJob.failed++;
              logger.warn("AUDIO_BATCH", `Sem filePath para faixa ${ratingKey} — ${track.grandparentTitle} – ${track.title}`);
              continue;
            }

            // Resolve Plex path → local filesystem path
            const filePath = audioAnalyzer ? audioAnalyzer._resolvePath(plexPath) : plexPath;

            if (!existsSync(filePath)) {
              batchJob.failed++;
              logger.warn("AUDIO_BATCH", `Arquivo não encontrado: ${filePath} (plexPath=${plexPath})`);
              continue;
            }

            try {
              const meta = {
                title:  track.title,
                artist: track.grandparentTitle,
                album:  track.parentTitle,
              };
              const analysis = await analyzer.analyzeAudioFile(filePath, meta, { maxAudioSecs });
              analysisCache.set(ratingKey, { ...meta, filePath }, analysis);
              batchJob.done++;
              logger.info("AUDIO_BATCH", `[${batchJob.done + batchJob.failed}/${batchJob.total}] ✓ ${meta.artist} – ${meta.title}`);
            } catch (err) {
              batchJob.failed++;
              logger.warn("AUDIO_BATCH", `Falha na análise ratingKey=${ratingKey}: ${err.message}`);
            }
          }
        }

        await Promise.all(Array.from({ length: cap }, worker));
        await analysisCache.flush();
        logger.info("AUDIO_BATCH", `Concluído — ${batchJob.done} ok, ${batchJob.failed} falharam`);
      } catch (err) {
        logger.error("AUDIO_BATCH", `Erro geral: ${err.message}`);
      } finally {
        batchJob.running = false;
      }
    })();
  });

  return router;
}
