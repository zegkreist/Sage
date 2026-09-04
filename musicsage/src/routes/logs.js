/**
 * GET  /api/logs           — lista arquivos de log + linhas recentes do arquivo de hoje
 * GET  /api/logs/today     — conteúdo completo do log de hoje
 * GET  /api/logs/files     — lista todos os arquivos de log com tamanho/data
 * DELETE /api/logs         — zera o arquivo de log de hoje (truncate)
 * DELETE /api/logs/all     — remove todos os arquivos de log
 */
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Em container usa LOG_DIR; em dev resolve relativo a musicsage/src/routes/ → ../../.. = plex_server/
const LOG_DIR   = process.env.LOG_DIR || join(__dirname, "../../../mediasage/logs");

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

  /** GET /api/logs/today — conteúdo completo do log de hoje.
   *  Com ?offset=N (bytes): retorna só as linhas completas após o offset
   *  (polling incremental — evita baixar o arquivo inteiro a cada 3s).
   *  offset > tamanho do arquivo (log zerado/rotacionado) → truncated=true
   *  e devolve o conteúdo completo. */
  router.get("/logs/today", (req, res) => {
    const todayFile = todayLogFile();
    const date = new Date().toISOString().slice(0, 10);
    if (!existsSync(todayFile)) return res.json({ lines: [], date, size: 0, nextOffset: 0 });
    const stat = statSync(todayFile);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    if (offset === 0 || offset > stat.size) {
      const content = readFileSync(todayFile, "utf8");
      const lines   = content.split("\n").filter(Boolean);
      return res.json({ lines, date, size: stat.size, nextOffset: stat.size, truncated: offset > stat.size });
    }
    if (offset === stat.size) {
      return res.json({ lines: [], date, size: stat.size, nextOffset: offset });
    }

    // Lê só o trecho novo
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    const fd = openSync(todayFile, "r");
    try {
      readSync(fd, buf, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    let lines, nextOffset;
    if (lastNewline === -1) {
      lines = [];                       // última linha ainda incompleta — aguarda fechar
      nextOffset = offset;
    } else {
      const complete = text.slice(0, lastNewline);
      lines = complete.split("\n").filter(Boolean);
      nextOffset = offset + Buffer.byteLength(complete, "utf8") + 1;
    }
    res.json({ lines, date, size: stat.size, nextOffset });
  });

  /** GET /api/logs/file/:name — conteúdo completo de qualquer arquivo de log (proteção path traversal) */
  router.get("/logs/file/:name", (req, res) => {
    const name = req.params.name;
    // Aceita apenas nomes no formato "musicsage-YYYY-MM-DD.log" — sem barras nem ".."
    if (!/^musicsage-\d{4}-\d{2}-\d{2}\.log$/.test(name)) {
      return res.status(400).json({ error: "Nome de arquivo inválido" });
    }
    const fp = join(LOG_DIR, name);
    if (!existsSync(fp)) return res.status(404).json({ error: "Arquivo não encontrado", lines: [] });
    try {
      const content = readFileSync(fp, "utf8");
      const lines   = content.split("\n").filter(Boolean);
      res.json({ lines, name, size: content.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
