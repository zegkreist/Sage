/**
 * Rotas de letras locais para o Plex
 *
 *   GET  /api/lyrics/stats          — cobertura da biblioteca (com/sem letras)
 *   GET  /api/lyrics/batch-progress — progresso do job em andamento
 *   POST /api/lyrics/batch-fetch    — inicia busca em lote; { stop: true } cancela
 */

import { existsSync } from "fs";
import { logger } from "../logger.js";

/** Estado global do job de busca em lote (um por vez por instância do servidor) */
const lyricsJob = {
  running:   false,
  total:     0,
  done:      0,
  failed:    0,
  notFound:  0,
  skipped:   0,
  current:   '',
  startedAt: null,
  aborted:   false,
};

/**
 * @param {import('express').Router} router
 * @param {{ lyricsService, libraryScanner }} deps
 */
export function lyricsRouter(router, { lyricsService, libraryScanner } = {}) {

  // ─── GET /api/lyrics/stats ────────────────────────────────────────────────
  router.get("/lyrics/stats", async (_req, res) => {
    if (!lyricsService || !libraryScanner) {
      return res.status(503).json({ error: "lyricsService ou libraryScanner não disponível" });
    }
    try {
      const { tracks } = await libraryScanner.scan();
      let withLyrics = 0;
      let withoutLyrics = 0;

      for (const track of tracks) {
        const plexPath = track.Media?.[0]?.Part?.[0]?.file;
        if (!plexPath) { withoutLyrics++; continue; }
        const localPath = lyricsService.resolvePath(plexPath);
        if (lyricsService.hasLyrics(localPath)) {
          withLyrics++;
        } else {
          withoutLyrics++;
        }
      }

      res.json({ withLyrics, withoutLyrics, total: tracks.length });
    } catch (err) {
      logger.error("LYRICS_ROUTE", `Falha em /lyrics/stats: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/lyrics/batch-progress ──────────────────────────────────────
  router.get("/lyrics/batch-progress", (_req, res) => {
    const processed = lyricsJob.done + lyricsJob.failed + lyricsJob.notFound + lyricsJob.skipped;
    const pct = lyricsJob.total > 0 ? Math.round(processed / lyricsJob.total * 100) : 0;
    res.json({ ...lyricsJob, processed, pct });
  });

  // ─── POST /api/lyrics/batch-fetch ─────────────────────────────────────────
  /**
   * Body:
   *   stop      {boolean?} — cancela o job em andamento
   *   overwrite {boolean?} — sobrescreve letras existentes (padrão: false)
   */
  router.post("/lyrics/batch-fetch", async (req, res) => {
    if (!lyricsService || !libraryScanner) {
      return res.status(503).json({ error: "lyricsService ou libraryScanner não disponível" });
    }

    const { stop, overwrite = false } = req.body ?? {};

    if (stop) {
      lyricsJob.aborted = true;
      return res.json({ message: "Cancelamento solicitado", ...lyricsJob });
    }

    if (lyricsJob.running) {
      return res.status(409).json({ error: "Busca de letras já está em andamento — aguarde ou cancele antes." });
    }

    // Responde imediatamente — processamento em background
    res.json({ message: "Busca de letras iniciada", status: "running" });

    (async () => {
      lyricsJob.running   = true;
      lyricsJob.aborted   = false;
      lyricsJob.done      = 0;
      lyricsJob.failed    = 0;
      lyricsJob.notFound  = 0;
      lyricsJob.skipped   = 0;
      lyricsJob.current   = '';
      lyricsJob.startedAt = new Date().toISOString();

      try {
        const { tracks } = await libraryScanner.scan();
        lyricsJob.total = tracks.length;
        logger.info("LYRICS_BATCH", `Iniciando busca de letras para ${tracks.length} faixas (overwrite=${overwrite})`);

        for (const track of tracks) {
          if (lyricsJob.aborted) break;

          const plexPath = track.Media?.[0]?.Part?.[0]?.file;
          if (!plexPath) {
            lyricsJob.failed++;
            continue;
          }

          const localPath = lyricsService.resolvePath(plexPath);

          if (!existsSync(localPath)) {
            lyricsJob.failed++;
            logger.warn("LYRICS_BATCH", `Arquivo não encontrado: ${localPath}`);
            continue;
          }

          if (!overwrite && lyricsService.hasLyrics(localPath)) {
            lyricsJob.skipped++;
            continue;
          }

          const title    = track.title           || "";
          const artist   = track.grandparentTitle || "";
          const album    = track.parentTitle      || "";
          // Plex retorna duration em milissegundos; LRCLIB espera segundos
          const duration = track.duration ? Math.round(track.duration / 1000) : undefined;

          lyricsJob.current = `${artist} – ${title}`;

          try {
            const lyrics = await lyricsService.fetchLyrics({ title, artist, album, duration });
            if (!lyrics) {
              lyricsJob.notFound++;
              logger.debug?.("LYRICS_BATCH", `Não encontrado: ${artist} – ${title}`);
            } else {
              const saved = lyricsService.saveLyrics(localPath, lyrics);
              if (saved) {
                lyricsJob.done++;
                const ext = saved.endsWith(".lrc") ? ".lrc" : ".txt";
                logger.info("LYRICS_BATCH", `[${lyricsJob.done}] ✓ ${artist} – ${title} (${ext})`);
              } else {
                lyricsJob.failed++;
              }
            }
          } catch (err) {
            lyricsJob.failed++;
            logger.warn("LYRICS_BATCH", `Falha: ${artist} – ${title}: ${err.message}`);
          }
        }

        logger.info(
          "LYRICS_BATCH",
          `Concluído — ${lyricsJob.done} salvas, ${lyricsJob.notFound} não encontradas, ` +
          `${lyricsJob.failed} falharam, ${lyricsJob.skipped} puladas`
        );
      } catch (err) {
        logger.error("LYRICS_BATCH", `Erro geral: ${err.message}`);
      } finally {
        lyricsJob.running = false;
        lyricsJob.current = '';
      }
    })();
  });

  return router;
}
