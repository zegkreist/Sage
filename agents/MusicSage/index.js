import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega o .env da raiz do monorepo (dois níveis acima de agents/MusicSage/)
const { config: dotenvConfig } = await import("dotenv");
dotenvConfig({ path: join(__dirname, "../../.env") });

import { logger } from "./src/logger.js";
import axios from "axios";
import { AllFather } from "@plex-agents/allfather";
import { LibraryScanner } from "./src/services/LibraryScanner.js";
import { HistoryService } from "./src/services/HistoryService.js";
import { MusicAnalyzer } from "./src/services/MusicAnalyzer.js";
import { RecommendationEngine } from "./src/services/RecommendationEngine.js";
import { PlaylistBuilder } from "./src/services/PlaylistBuilder.js";
import { createServer } from "./src/server.js";

const PORT = parseInt(process.env.MUSICSAGE_PORT || "3001", 10);
const PLEX_URL = process.env.PLEX_URL || "http://localhost:32400";
const PLEX_TOKEN = process.env.PLEX_TOKEN || "";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_DEFAULT_MODEL || "deepseek-r1:14b-qwen-distill-q4_K_M";

// ── Instancia serviços ────────────────────────────────────────────────────

const allfather = new AllFather({
  ollamaUrl: OLLAMA_URL,
  model: MODEL,
  temperature: 0.5,
  disableReasoning: true,
});

const libraryScanner = new LibraryScanner({ axios, plexUrl: PLEX_URL, plexToken: PLEX_TOKEN });
const historyService = new HistoryService({ axios, plexUrl: PLEX_URL, plexToken: PLEX_TOKEN });
const analyzer = new MusicAnalyzer({ allfather });

const recommendationEngine = new RecommendationEngine({
  allfather,
  libraryScanner,
  historyService,
  analyzer,
});

const playlistBuilder = new PlaylistBuilder({ allfather, libraryScanner });

// ── Inicializa e faz scan inicial da biblioteca ───────────────────────────

logger.info("SERVER", "🎵 MusicSage — iniciando...");
logger.info("SERVER", `Plex: ${PLEX_URL}`);
logger.info("SERVER", `Ollama: ${OLLAMA_URL} (${MODEL})`);
logger.info("SERVER", `Log: ${logger.logFilePath()}`);

// Scan em background — não bloqueia a subida do servidor
libraryScanner.scan().then((result) => {
  logger.info("LIBRARY", "Biblioteca carregada", { artists: result.artists.length, albums: result.albums.length, tracks: result.tracks.length });
}).catch(() => {
  logger.warn("LIBRARY", "Plex indisponível — biblioteca será carregada sob demanda");
});

// ── Sobe o servidor ───────────────────────────────────────────────────────

const app = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder });

const server = app.listen(PORT);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logger.error("SERVER", `Porta ${PORT} já está em uso`);
    logger.error("SERVER", `Para liberar: node scripts/kill-port.js ${PORT}`);
    logger.error("SERVER", `Ou defina MUSICSAGE_PORT=${PORT + 1} no .env para usar outra porta`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.on("listening", () => {
  logger.info("SERVER", `✅ MusicSage rodando em http://localhost:${PORT}`);
  logger.info("SERVER", "Endpoints: /api/health | /api/library/stats | /api/recommendations | /api/playlists");
});
