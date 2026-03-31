import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { healthRouter } from "./routes/health.js";
import { libraryRouter } from "./routes/library.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { playlistsRouter } from "./routes/playlists.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Factory do servidor Express.
 * Recebe os serviços como dependências (facilita testes com mocks).
 *
 * @param {{ libraryScanner, historyService, recommendationEngine, playlistBuilder }} deps
 * @returns {import('express').Application}
 */
export function createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder } = {}) {
  const app = express();

  app.use(express.json());

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
  libraryRouter(router, { libraryScanner });
  recommendationsRouter(router, { recommendationEngine });
  playlistsRouter(router, { playlistBuilder });

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
