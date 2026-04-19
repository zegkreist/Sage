import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { healthRouter } from "./routes/health.js";
import { libraryRouter } from "./routes/library.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { playlistsRouter } from "./routes/playlists.js";
import { embeddingsRouter } from "./routes/embeddings.js";
import { toolsRouter } from "./routes/tools.js";
import { audioRouter } from "./routes/audio.js";
import { logsRouter } from "./routes/logs.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Factory do servidor Express.
 * Recebe os serviços como dependências (facilita testes com mocks).
 *
 * @param {{ libraryScanner, historyService, recommendationEngine, playlistBuilder }} deps
 * @returns {import('express').Application}
 */
export function createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, plexService, embeddingService, clusteringService, metricsService, analyzer, audioAnalyzer, analysisCache } = {}) {
  const app = express();

  app.use(express.json({ limit: '10mb' })); // tracks Plex são ~3KB cada; playlists grandes podem exceder 100 KB

  // Serve frontend estático de public/
  app.use(express.static(join(__dirname, "../public")));

  // Prefixo /api para todas as rotas
  const router = express.Router();

  // Log de cada request /api: method, path, status, ms
  router.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () =>
      logger.http(req.method, "/api" + req.path, res.statusCode, Date.now() - start)
    );
    next();
  });

  healthRouter(router);
  logsRouter(router);
  libraryRouter(router, { libraryScanner, historyService, metricsService, audioAnalyzer, analysisCache, playlistBuilder, plexService });
  recommendationsRouter(router, { recommendationEngine });
  playlistsRouter(router, { playlistBuilder, plexService, analysisCache });
  embeddingsRouter(router, { embeddingService, clusteringService, playlistBuilder, analysisCache });
  audioRouter(router, { analyzer, embeddingService, audioAnalyzer, playlistBuilder, plexService, analysisCache, libraryScanner });
  toolsRouter(router);

  app.use("/api", router);

  // SPA: qualquer rota não-/api cai no index.html
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(__dirname, "../public/index.html"));
  });

  // 404 para /api não encontradas
  app.use((_req, res) => {
    res.status(404).json({ error: "Rota não encontrada" });
  });

  return app;
}
