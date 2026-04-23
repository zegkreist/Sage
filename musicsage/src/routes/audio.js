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
  current:   '',    // nome da faixa sendo processada
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

  router.get("/audio/analysis-cache", async (_req, res) => {
    if (!analysisCache) return res.status(503).json({ error: "AnalysisCacheService não disponível" });
    await analysisCache.load(); // lazy load: no-op se já carregado
    res.json(analysisCache.toJSON());
  });

  // ─── POST /api/audio/analysis-cache/remap-ids ─────────────────────────────
  // Corrige ratingKeys do cache comparando title+artist com a biblioteca Plex atual.
  // Útil quando o cache foi importado de outra instância do Plex (IDs diferentes).
  router.post("/audio/analysis-cache/remap-ids", async (_req, res) => {
    if (!analysisCache) return res.status(503).json({ error: "AnalysisCacheService não disponível" });
    if (!libraryScanner) return res.status(503).json({ error: "LibraryScanner não disponível" });

    try {
      await analysisCache.load(); // lazy load: no-op se já carregado
      const { tracks } = await libraryScanner.scan();

      // Mapa: normalize(title|artist) → ratingKey atual do Plex
      const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const plexMap = new Map();
      for (const t of tracks) {
        const key = normalize(t.title) + "|" + normalize(t.grandparentTitle);
        // Mantém o primeiro match (evita colisão de covers/remixes do mesmo artista)
        if (!plexMap.has(key)) plexMap.set(key, String(t.ratingKey));
      }

      let remapped = 0;
      let notFound = 0;
      let unchanged = 0;
      const details = [];

      for (const entry of analysisCache.getAll()) {
        const lookupKey = normalize(entry.title) + "|" + normalize(entry.artist);
        const currentKey = plexMap.get(lookupKey);

        if (!currentKey) {
          // Faixa não existe na biblioteca atual — remove do cache
          analysisCache.delete(String(entry.ratingKey));
          notFound++;
          details.push({ title: entry.title, artist: entry.artist, status: "deleted", oldKey: entry.ratingKey });
          continue;
        }

        if (currentKey === String(entry.ratingKey)) {
          unchanged++;
          continue;
        }

        // Remapeia: remove oldKey, insere newKey
        analysisCache.remap(String(entry.ratingKey), currentKey);
        remapped++;
        details.push({ title: entry.title, artist: entry.artist, status: "remapped", oldKey: entry.ratingKey, newKey: currentKey });
      }

      await analysisCache.flush();

      logger.info("ANALYSIS_CACHE", `Remap concluído: ${remapped} corrigidos, ${unchanged} inalterados, ${notFound} deletados (não encontrados na biblioteca)`);
      res.json({ remapped, unchanged, notFound, total: remapped + unchanged + notFound, details });
    } catch (err) {
      logger.error("ANALYSIS_CACHE", `Falha em remap-ids: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/audio/reanalyze-artist ────────────────────────────────────
  /**
   * Limpa análises de todas as faixas de um artista específico e as refaz.
   * Reutiliza o estado batchJob para que o frontend possa acompanhar via
   * GET /api/audio/batch-progress.
   *
   * Body:
   *   artist        {string}  — nome do artista (case-insensitive)
   *   maxAudioSecs  {number?} — duração do trecho de áudio (padrão: 30)
   *   concurrency   {number?} — análises paralelas (padrão: 1, máx: 3)
   */
  router.post("/audio/reanalyze-artist", async (req, res) => {
    if (!analyzer || !libraryScanner || !analysisCache) {
      return res.status(503).json({ error: "analyzer, libraryScanner ou analysisCache não disponível" });
    }

    if (batchJob.running) {
      return res.status(409).json({ error: "Análise em lote já está em andamento — aguarde ou cancele antes." });
    }

    const { artist, maxAudioSecs = 30, concurrency = 1 } = req.body ?? {};

    if (!artist || typeof artist !== "string" || !artist.trim()) {
      return res.status(400).json({ error: "Campo 'artist' obrigatório" });
    }

    const artistName = artist.trim();

    // Responde imediatamente
    res.json({ message: `Reanálise de "${artistName}" iniciada`, status: "running" });

    (async () => {
      batchJob.running   = true;
      batchJob.aborted   = false;
      batchJob.done      = 0;
      batchJob.failed    = 0;
      batchJob.current   = '';
      batchJob.startedAt = new Date().toISOString();

      try {
        await analysisCache.load();
        const { tracks } = await libraryScanner.scan();

        const normalize = (s) => (s || "").toLowerCase().trim();
        const todo = tracks.filter(
          (t) => normalize(t.grandparentTitle) === normalize(artistName)
        );

        if (todo.length === 0) {
          logger.warn("AUDIO_REANALYZE", `Nenhuma faixa encontrada para "${artistName}"`);
          batchJob.total = 0;
          return;
        }

        // Remove entradas antigas do cache para forçar reanálise
        let removed = 0;
        for (const t of todo) {
          if (analysisCache.has(String(t.ratingKey))) {
            analysisCache.delete(String(t.ratingKey));
            removed++;
          }
        }
        logger.info("AUDIO_REANALYZE", `"${artistName}": ${todo.length} faixas, ${removed} entradas removidas`);

        batchJob.total = todo.length;
        const cap = Math.min(Math.max(1, concurrency), 3);
        let idx = 0;

        async function worker() {
          while (idx < todo.length && !batchJob.aborted) {
            const track    = todo[idx++];
            const ratingKey = String(track.ratingKey);
            const plexPath  = track.Media?.[0]?.Part?.[0]?.file;

            if (!plexPath) {
              batchJob.failed++;
              logger.warn("AUDIO_REANALYZE", `Sem filePath para faixa ${ratingKey}`);
              continue;
            }

            const filePath = audioAnalyzer ? audioAnalyzer._resolvePath(plexPath) : plexPath;
            if (!existsSync(filePath)) {
              batchJob.failed++;
              logger.warn("AUDIO_REANALYZE", `Arquivo não encontrado: ${filePath}`);
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
              batchJob.current = `${meta.artist} – ${meta.title}`;
              logger.info("AUDIO_REANALYZE", `[${batchJob.done}/${batchJob.total}] ✓ ${meta.artist} – ${meta.title}`);
            } catch (err) {
              batchJob.failed++;
              logger.warn("AUDIO_REANALYZE", `Falha ratingKey=${ratingKey}: ${err.message}`);
            }
          }
        }

        await Promise.all(Array.from({ length: cap }, worker));
        await analysisCache.flush();
        logger.info("AUDIO_REANALYZE", `Concluído "${artistName}" — ${batchJob.done} ok, ${batchJob.failed} falharam`);
      } catch (err) {
        logger.error("AUDIO_REANALYZE", `Erro geral: ${err.message}`);
      } finally {
        batchJob.running = false;
        batchJob.current = '';
      }
    })();
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
    // 'processed' = alias de 'done' para compatibilidade com o frontend
    res.json({ ...batchJob, processed: batchJob.done, pct });
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

    // Aceita tanto 'abort' quanto 'stop' (compatibilidade com o frontend)
    const { abort, stop, maxAudioSecs = 30, concurrency = 1, skipExisting = true } = req.body ?? {};

    if (abort || stop) {
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
      batchJob.current   = '';
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
              batchJob.current = `${meta.artist} – ${meta.title}`;
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
        batchJob.current = '';
      }
    })();
  });

  return router;
}
