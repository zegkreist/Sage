/**
 * Logger singleton para o MusicSage.
 *
 * • Grava em: mediasage/logs/musicsage-YYYY-MM-DD.log  (um arquivo por dia)
 * • Em NODE_ENV=test todo output (arquivo + console) é suprimido.
 * • Logs DEBUG exigem MUSICSAGE_DEBUG=1.
 *
 * Uso:
 *   import { logger } from "../logger.js"; // ajuste o caminho conforme necessário
 *   logger.info("PLAYLIST", "Playlist criada", { id, name });
 *   logger.error("OLLAMA", "Falha ao chamar LLM", err);
 *
 * Categorias convencionadas: SERVER | HTTP | LIBRARY | PLAYLIST | RECOMMEND | OLLAMA
 */

import { mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// mediasage/logs/ — pasta de logs na raiz do projeto
const LOG_DIR = join(__dirname, "../../../mediasage/logs");

const IS_TEST = process.env.NODE_ENV === "test";

// Garante que a pasta existe (apenas fora de testes)
if (!IS_TEST) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    process.stderr.write(`[Logger] Falha ao criar diretório de logs: ${err.message}\n`);
  }
}

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
};

const LEVEL_COLOR = { INFO: C.green, WARN: C.yellow, ERROR: C.red, DEBUG: C.dim };
const CAT_COLOR   = {
  SERVER: C.green, HTTP: C.cyan, LIBRARY: C.cyan,
  PLAYLIST: C.magenta, RECOMMEND: C.blue, OLLAMA: C.magenta,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function todayFile() {
  return join(LOG_DIR, `musicsage-${new Date().toISOString().slice(0, 10)}.log`);
}

function serialize(extra) {
  if (!extra) return "";
  if (typeof extra === "string") return extra;
  if (extra instanceof Error) return `${extra.message}${extra.stack ? "\n" + extra.stack : ""}`;
  try { return JSON.stringify(extra); } catch { return String(extra); }
}

// ── Logger ────────────────────────────────────────────────────────────────────
class Logger {
  /**
   * Escreve uma linha no arquivo de log e no console.
   * @param {"INFO"|"WARN"|"ERROR"|"DEBUG"} level
   * @param {string} category
   * @param {string} message
   * @param {any} [extra] — objeto, string ou Error adicionado ao final da linha
   */
  _write(level, category, message, extra) {
    if (IS_TEST) return; // silencia completamente em testes

    const isDebug = level === "DEBUG";
    const debugEnabled = process.env.MUSICSAGE_DEBUG === "1";
    if (isDebug && !debugEnabled) {
      // Ainda grava em arquivo (para análise), mas não mostra no console
      const now = timestamp();
      const extraStr = extra ? " — " + serialize(extra) : "";
      try {
        appendFileSync(
          todayFile(),
          `${now} [${level.padEnd(5)}] [${category.padEnd(9)}] ${message}${extraStr}\n`
        );
      } catch {}
      return;
    }

    const now = timestamp();
    const extraStr = extra ? " — " + serialize(extra) : "";

    // ── Arquivo (sem cores) ──────────────────────────────────────────────────
    try {
      appendFileSync(
        todayFile(),
        `${now} [${level.padEnd(5)}] [${category.padEnd(9)}] ${message}${extraStr}\n`
      );
    } catch { /* falha silenciosa — não travar a aplicação */ }

    // ── Console (com cores) ──────────────────────────────────────────────────
    const lc = LEVEL_COLOR[level] ?? "";
    const cc = CAT_COLOR[category] ?? "";
    const extraConsole = extra ? ` ${C.dim}${serialize(extra)}${C.reset}` : "";
    const line = `${C.dim}${now}${C.reset} ${lc}[${level.padEnd(5)}]${C.reset} ${cc}[${category}]${C.reset} ${message}${extraConsole}`;

    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  }

  info (cat, msg, extra) { this._write("INFO",  cat, msg, extra); }
  warn (cat, msg, extra) { this._write("WARN",  cat, msg, extra); }
  error(cat, msg, extra) { this._write("ERROR", cat, msg, extra); }
  debug(cat, msg, extra) { this._write("DEBUG", cat, msg, extra); }

  /**
   * Log específico para requests HTTP.
   * @param {string} method
   * @param {string} path
   * @param {number} status
   * @param {number} ms  — duração em milissegundos
   */
  http(method, path, status, ms) {
    if (IS_TEST) return;

    const now = timestamp();
    const statusColor = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;

    try {
      appendFileSync(
        todayFile(),
        `${now} [INFO ] [HTTP     ] ${method.padEnd(6)} ${path} → ${status} (${ms}ms)\n`
      );
    } catch {}

    console.log(
      `${C.dim}${now}${C.reset} ${C.cyan}[HTTP]${C.reset} ` +
      `${method.padEnd(6)} ${path} → ${statusColor}${status}${C.reset} ${C.dim}(${ms}ms)${C.reset}`
    );
  }

  /**
   * Retorna o caminho do arquivo de log de hoje.
   * @returns {string}
   */
  logFilePath() {
    return todayFile();
  }
}

export const logger = new Logger();
