/**
 * GET  /api/logs           — lista arquivos de log + linhas recentes do arquivo de hoje
 * GET  /api/logs/today     — conteúdo completo do log de hoje
 * GET  /api/logs/files     — lista todos os arquivos de log com tamanho/data
 * DELETE /api/logs         — zera o arquivo de log de hoje (truncate)
 * DELETE /api/logs/all     — remove todos os arquivos de log
 */
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = src/routes/ → go up 4 levels to reach plex_server/
const LOG_DIR   = join(__dirname, "../../../../mediasage/logs");

function listLogFiles() {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".log"))
    .map((f) => {
      const fp   = join(LOG_DIR, f);
      const stat = statSync(fp);
      return { name: f, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name)); // mais recente primeiro
}

function todayLogFile() {
  return join(LOG_DIR, `musicsage-${new Date().toISOString().slice(0, 10)}.log`);
}

export function logsRouter(router) {
  /** GET /api/logs — resumo: lista arquivos + últimas 200 linhas de hoje */
  router.get("/logs", (_req, res) => {
    const files   = listLogFiles();
    const todayFile = todayLogFile();
    let recentLines = [];
    if (existsSync(todayFile)) {
      const content = readFileSync(todayFile, "utf8");
      recentLines   = content.split("\n").filter(Boolean).slice(-200);
    }
    res.json({ files, recentLines, logDir: LOG_DIR });
  });

  /** GET /api/logs/today — conteúdo completo do log de hoje */
  router.get("/logs/today", (_req, res) => {
    const todayFile = todayLogFile();
    if (!existsSync(todayFile)) return res.json({ lines: [], date: new Date().toISOString().slice(0, 10) });
    const content = readFileSync(todayFile, "utf8");
    const lines   = content.split("\n").filter(Boolean);
    res.json({ lines, date: new Date().toISOString().slice(0, 10), size: content.length });
  });

  /** GET /api/logs/files — lista de arquivos de log */
  router.get("/logs/files", (_req, res) => {
    res.json({ files: listLogFiles() });
  });

  /** DELETE /api/logs — zera (truncate) o arquivo de log de hoje */
  router.delete("/logs", (_req, res) => {
    const todayFile = todayLogFile();
    try {
      writeFileSync(todayFile, "", "utf8");
      logger.info("LOGS", "Log de hoje zerado via API");
      res.json({ ok: true, message: "Log de hoje zerado" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /api/logs/all — remove todos os arquivos de log */
  router.delete("/logs/all", (_req, res) => {
    try {
      const files = listLogFiles();
      let removed = 0;
      for (const f of files) {
        try { unlinkSync(join(LOG_DIR, f.name)); removed++; } catch {}
      }
      logger.info("LOGS", `${removed} arquivo(s) de log removido(s) via API`);
      res.json({ ok: true, removed, message: `${removed} arquivo(s) removido(s)` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
