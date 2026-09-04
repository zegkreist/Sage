/**
 * Rotas de integração com ferramentas externas do monorepo:
 *   POST /api/tools/stormbringer/search        — busca torrents de música
 *   POST /api/tools/stormbringer/search/movie  — busca torrents de filme
 *   POST /api/tools/stormbringer/search/series — busca torrents de série
 *   GET  /api/tools/stormbringer/feeds         — lista feeds RSS configurados
 *   GET  /api/tools/stormbringer/feeds/browse  — últimos itens dos feeds ativos
 *   GET  /api/tools/stormbringer/feeds/check   — verifica novos lançamentos dos artistas monitorados
 *   GET  /api/tools/stormbringer/tracked       — lista artistas monitorados
 *   POST /api/tools/stormbringer/tracked       — adiciona artista ao monitoramento
 *   POST /api/tools/stormbringer/download      — baixa torrent de música por magnet
 *   POST /api/tools/stormbringer/download/media — baixa torrent de filme/série por magnet
 *   POST /api/tools/tidecaller/download        — inicia download via TideCaller/streamrip
 *   POST /api/tools/tidecaller/album/download-url — baixa um álbum por link do Tidal
 *   POST /api/tools/transporter/run            — move downloads para o Plex
 */
import { randomUUID } from "crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import http from "http";
import https from "https";
import { logger } from "../logger.js";
import axios from "axios";

const _httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Faz um GET seguindo redirects manualmente.
 * Se o redirect aponta para magnet:, retorna { magnet }.
 * Caso contrário, retorna o Buffer do corpo da resposta final.
 */
function _httpGetFollowMagnet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const opts = url.startsWith("https") ? { rejectUnauthorized: false } : {};
    const req = lib.get(url, opts, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        const loc = headers.location;
        res.destroy();
        logger.info("SERVER", `Redirect ${statusCode} → ${loc.slice(0, 120)}`);
        if (loc.startsWith("magnet:")) return resolve({ magnet: loc });
        // Redirect relativo → absoluto
        const next = loc.startsWith("http") ? loc : new URL(loc, url).toString();
        return resolve(_httpGetFollowMagnet(next, redirectsLeft - 1));
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.destroy();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    // Mesmo timeout usado na busca do Jackett (torrentSearch.js) — o download do
    // .torrent passa pelo mesmo proxy até o indexer/tracker de origem, que pode
    // ser igualmente lento.
    req.setTimeout(55_000, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

// Resolve um torrent id: magnet links passam direto;
// URLs de .torrent são baixadas server-side com controle de redirect para magnet:.
async function resolveTorrentId(id) {
  if (!id) return id;
  const s = id.trim();
  if (s.startsWith("magnet:")) return s;
  if (s.startsWith("http://") || s.startsWith("https://")) {
    logger.info("SERVER", `Resolvendo .torrent via URL: ${s.slice(0, 120)}`);
    try {
      const result = await _httpGetFollowMagnet(s);
      if (result.magnet) {
        logger.info("SERVER", `Jackett retornou magnet via redirect`);
        return result.magnet;
      }
      logger.info("SERVER", `Buffer .torrent obtido: ${result.buffer.byteLength} bytes`);
      return result.buffer;
    } catch (e) {
      const hint = e.message === "timeout"
        ? " — indexer do Jackett provavelmente lento/travado, rode scripts/test-jackett.js --agg para achar qual"
        : "";
      throw new Error(`Falha ao baixar .torrent (${e.message})${hint} — ${s.slice(0, 120)}`);
    }
  }
  return s;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Caminhos absolutos para os agents irmãos no monorepo
// Em container: sobrepõe com as env vars *_DIR
const STORMBRINGER_DIR = process.env.STORMBRINGER_DIR || join(__dirname, "../../../agents/Stormbringer");
const TIDECALLER_DIR   = process.env.TIDECALLER_DIR   || join(__dirname, "../../../agents/TideCaller");
const TRANSPORTER_DIR  = process.env.TRANSPORTER_DIR  || join(__dirname, "../../../agents/Transporter");

// Carrega config do Stormbringer com paths resolvidos em absoluto
function loadStormbringerConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(STORMBRINGER_DIR, "config.json"), "utf8"));
    // Resolver paths relativos para absolutos
    const dl = raw.downloads;
    raw.downloads = {
      baseDir:   resolve(STORMBRINGER_DIR, dl.baseDir),
      movies:    resolve(STORMBRINGER_DIR, dl.movies),
      series:    resolve(STORMBRINGER_DIR, dl.series),
      music:     resolve(STORMBRINGER_DIR, dl.music),
      stateFile: dl.stateFile ? resolve(STORMBRINGER_DIR, dl.stateFile) : join(STORMBRINGER_DIR, ".download-state.json"),
    };
    if (raw.music?.trackerFile) {
      raw.music.trackerFile = resolve(STORMBRINGER_DIR, raw.music.trackerFile);
    }
    if (raw.series?.trackerFile) {
      raw.series.trackerFile = resolve(STORMBRINGER_DIR, raw.series.trackerFile);
    }
    return raw;
  } catch (err) {
    // Config ausente/corrompido não pode derrubar o boot do servidor —
    // features que dependem dele falham na hora de uso, não no startup
    logger.warn("SERVER", `Stormbringer config.json indisponível (${err.message}) — usando defaults`);
    return {
      downloads: {
        baseDir:   join(STORMBRINGER_DIR, "downloads"),
        movies:    join(STORMBRINGER_DIR, "downloads", "filmes"),
        series:    join(STORMBRINGER_DIR, "downloads", "series"),
        music:     join(STORMBRINGER_DIR, "downloads", "musicas"),
        stateFile: join(STORMBRINGER_DIR, ".download-state.json"),
      },
    };
  }
}

// Lazy-load do singleton TorrentSearch do Stormbringer
let _torrentSearch = null;
async function getTorrentSearch() {
  if (!_torrentSearch) {
    const mod = await import("../../../agents/Stormbringer/src/torrentSearch.js");
    _torrentSearch = mod.default;
    _torrentSearch.setLogger((level, msg) => logger[level]("STORMBRINGER", msg));
  }
  return _torrentSearch;
}

// Lazy-load da classe MusicFeedTracker (não é singleton — instanciar por chamada)
let _MusicFeedTracker = null;
async function getMusicFeedTracker() {
  if (!_MusicFeedTracker) {
    const mod = await import("../../../agents/Stormbringer/src/musicFeedTracker.js");
    _MusicFeedTracker = mod.default;
  }
  return _MusicFeedTracker;
}

// Singleton do DownloadManager — persiste pelo ciclo de vida do processo
let _DownloadManagerClass = null;
let _dmInstance = null;
async function getDmInstance() {
  if (!_DownloadManagerClass) {
    const mod = await import("../../../agents/Stormbringer/src/downloadManager.js");
    _DownloadManagerClass = mod.default;
  }
  if (!_dmInstance) {
    _dmInstance = new _DownloadManagerClass(loadStormbringerConfig());
    _dmInstance.setLogger((level, msg) => logger[level]("STORMBRINGER", msg));
    // Fila unificada: torrent concluído/falho vai pro histórico e dispara
    // o Transporter automaticamente (se o toggle estiver ligado)
    _dmInstance.on("completed", (ti) => {
      _pushQueueHistory({ source: "torrent", id: ti?.infoHash, title: ti?.name, status: "done" });
      if (!_autoTransporter) return;
      const typeMap = { music: "music", movie: "movies", movies: "movies", series: "series", tv: "series" };
      const target = typeMap[ti?.type];
      if (target) runTransporter(target, { auto: true });
    });
    _dmInstance.on("error", ({ torrentInfo, error } = {}) => {
      _pushQueueHistory({
        source: "torrent", id: torrentInfo?.infoHash, title: torrentInfo?.name, status: "error",
        error: String(error?.message || error || "").slice(0, 200),
      });
    });
  }
  return _dmInstance;
}

// Sessões OAuth em andamento (limpas após 5 min)
const _oauthSessions = new Map();

// Jobs do TideCaller em andamento / histórico recente (limpos após 30 min)
const _tidalJobs = new Map();
// Processos do TideCaller por jobId (para cancelamento)
const _tidalProcs = new Map();
// Path do state file do Stormbringer
const SB_STATE_FILE = loadStormbringerConfig().downloads.stateFile;

// ── Fila unificada: Transporter rastreado + histórico + toggle ─────────────
const _transporterRuns = new Map();   // id → run {id,type,status,startedAt,...}
const _DATA_DIR = process.env.DATA_DIR || join(__dirname, "../../data");
const _QUEUE_HISTORY_FILE = join(_DATA_DIR, "queue-history.json");
const _SETTINGS_FILE = join(_DATA_DIR, "settings.json");
const _QUEUE_HISTORY_MAX = 100;

function _readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function _writeJsonSafe(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) { logger.warn("SERVER", `Falha ao gravar ${file}: ${err.message}`); }
}
let _autoTransporter = _readJsonSafe(_SETTINGS_FILE, {}).autoTransporter !== false;

function _pushQueueHistory(entry) {
  const hist = _readJsonSafe(_QUEUE_HISTORY_FILE, []);
  hist.unshift({ ...entry, finishedAt: entry.finishedAt || new Date().toISOString() });
  _writeJsonSafe(_QUEUE_HISTORY_FILE, hist.slice(0, _QUEUE_HISTORY_MAX));
}

/** Executa o Transporter rastreado (status + histórico). Dedup por target. */
function runTransporter(type, { auto = false } = {}) {
  for (const r of _transporterRuns.values()) {
    if (r.status === "running" && r.type === type) {
      logger.info("SERVER", `Transporter (${type}) já em andamento — gatilho ${auto ? "automático" : "manual"} ignorado`);
      return null;
    }
  }
  const flagMap = { music: ["--music"], movies: ["--movies"], series: ["--series"], all: [] };
  const flags = flagMap[type] ?? ["--music"];
  const id = randomUUID();
  const run = {
    id, source: "transporter", type,
    title: `Transporter — ${type}`,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null, exitCode: null, lastError: null, auto,
  };
  _transporterRuns.set(id, run);
  const _dl = process.env.DOWNLOADS_DIR || "/downloads";
  const _media = process.env.PLEX_MEDIA_PATH || "/media";
  logger.info("SERVER", `Transporter (${type}, ${auto ? "auto" : "manual"}) — origem: ${_dl} → destino: ${_media}`);

  const child = spawn("node", ["src/run.js", ...flags], {
    cwd: TRANSPORTER_DIR,
    env: { ...process.env, DOWNLOADS_DIR: _dl, PLEX_MEDIA_PATH: _media },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderrTail = "";
  child.stderr?.on("data", c => { stderrTail = (stderrTail + c.toString()).slice(-500); });
  child.on("close", (code) => {
    run.finishedAt = new Date().toISOString();
    run.exitCode = code;
    run.status = code === 0 ? "done" : "error";
    if (code !== 0) run.lastError = stderrTail.trim() || `exit ${code}`;
    logger.info("SERVER", `Transporter (${type}) ${run.status} código=${code}`);
    _pushQueueHistory({ source: "transporter", id, title: run.title, status: run.status, finishedAt: run.finishedAt, error: run.lastError });
    setTimeout(() => _transporterRuns.delete(id), 30 * 60 * 1000);
  });
  child.on("error", (err) => {
    run.status = "error";
    run.lastError = err.message;
    run.finishedAt = new Date().toISOString();
  });
  child.unref();
  return run;
}

// Python venv do TideCaller.
// Em container o venv pode não existir (deps instaladas no Python do sistema);
// nesse caso cai para o python3 do sistema.
const _TC_VENV_PYTHON = join(TIDECALLER_DIR, ".venv_tidal", "bin", "python3");
const TC_PYTHON = existsSync(_TC_VENV_PYTHON) ? _TC_VENV_PYTHON : "python3";
const TC_QUERY  = join(TIDECALLER_DIR, "scripts", "tidal_query.py");

/** Executa tidal_query.py e resolve com o JSON parseado da última linha. */
function tidalQuery(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, XDG_CONFIG_HOME: join(TIDECALLER_DIR, "config", ".config") };
    execFile(TC_PYTHON, [TC_QUERY, ...args], { env, cwd: TIDECALLER_DIR, timeout: timeoutMs }, (err, stdout, stderr) => {
      const last = (stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
      let data;
      try { data = JSON.parse(last); } catch { data = { raw: last }; }
      if (data?.error) return reject(new Error(data.error));
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(data);
    });
  });
}

/**
 * Extrai o ID numérico de um link de álbum do Tidal.
 * Aceita tidal.com/album/ID, tidal.com/browse/album/ID, listen.tidal.com/album/ID
 * (com ou sem query string) e também um ID cru colado direto.
 * Retorna null se não for um link de álbum.
 */
function parseTidalAlbumId(url) {
  const s = String(url || "").trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/tidal\.com\/(?:browse\/)?album\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Registra um job de download de álbuns e dispara o tidal_query.py em background,
 * atualizando o job conforme as linhas JSON de progresso chegam.
 * Compartilhado pelo download por artista e pelo download por link do Tidal.
 */
function startTidalAlbumJob(ids, albumMeta, artistName) {
  const jobId = randomUUID();
  const job = {
    jobId,
    artistName: artistName || null,
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    status: "running",
    albums: ids.map(id => ({ id, name: albumMeta[id] || id, status: "pending" })),
    lastError: null,
  };
  _tidalJobs.set(jobId, job);

  const label = artistName ? `${artistName} (${ids.length} álbuns)` : `${ids.length} álbuns`;
  logger.info("SERVER", `TideCaller download iniciado — jobId=${jobId} ${label}`);

  const _tcDownloads = join(process.env.DOWNLOADS_DIR || "/downloads", "tidecaller");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(TIDECALLER_DIR, "config", ".config"),
    TIDECALLER_DOWNLOADS: _tcDownloads,
  };
  logger.info("SERVER", `TideCaller download dir: ${_tcDownloads}`);
  const proc = spawn(TC_PYTHON, [TC_QUERY, "download-albums", ...ids], {
    cwd: TIDECALLER_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  _tidalProcs.set(jobId, proc);

  let buf = "";
  proc.stdout.on("data", chunk => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        if (parsed.albumId) {
          const entry = job.albums.find(a => a.id === parsed.albumId);
          if (entry) {
            entry.status = parsed.ok ? "done" : "error";
            if (parsed.error) entry.lastError = parsed.error;
            if (parsed.tracksExpected != null) {
              entry.tracksExpected = parsed.tracksExpected;
              entry.tracksDownloaded = parsed.tracksDownloaded;
              entry.complete = parsed.complete;
            }
            const icon = parsed.ok ? "✓" : "✗";
            const qualityNote = parsed.quality != null ? ` (q=${parsed.quality})` : "";
            const tracksNote = parsed.tracksExpected != null ? ` [${parsed.tracksDownloaded ?? "?"}/${parsed.tracksExpected}]` : "";
            logger.info("SERVER", `TideCaller [${icon}] álbum jobId=${jobId} id=${parsed.albumId} "${entry.name}"${qualityNote}${tracksNote}`);
            if (!parsed.ok && parsed.error) logger.warn("SERVER", `TideCaller erro álbum ${parsed.albumId}: ${parsed.error}`);
            if (parsed.ok && parsed.output)  logger.info("SERVER", `TideCaller saida álbum ${parsed.albumId}: ${parsed.output}`);
          }
        } else if (parsed.done) {
          job.status = "done";
        }
      } catch { /* non-JSON line — ignore */ }
    }
  });
  let _stderrBuf = "";
  proc.stderr.on("data", chunk => { _stderrBuf += chunk.toString(); job.lastError = _stderrBuf.slice(-500); });
  proc.on("close", code => {
    _tidalProcs.delete(jobId);
    job.finishedAt = new Date().toISOString();
    // Albums still "pending" at close: mark as error (if they got no JSON status they didn't download)
    job.albums.forEach(a => { if (a.status === "pending") a.status = "error"; });
    const done  = job.albums.filter(a => a.status === "done").length;
    const error = job.albums.filter(a => a.status === "error").length;
    job.status = job.status === "running" ? (error === 0 && done > 0 ? "done" : "error") : job.status;
    const icon  = job.status === "done" ? "✓" : "✗";
    logger.info("SERVER", `TideCaller download ${icon} jobId=${jobId} ${label} — ok=${done} erros=${error} (código=${code})`);
    if (job.lastError) logger.warn("SERVER", `TideCaller stderr jobId=${jobId}: ${job.lastError}`);
    _pushQueueHistory({ source: "tidal", id: jobId, title: label, status: job.status, finishedAt: job.finishedAt, error: job.lastError });
    // Fila unificada: downloads do Tidal prontos → transporta pra biblioteca
    if (_autoTransporter && job.status === "done") runTransporter("music", { auto: true });
    // Limpar após 60 min
    setTimeout(() => _tidalJobs.delete(jobId), 60 * 60 * 1000);
  });
  proc.on("error", err => {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.lastError = err.message;
    logger.error("SERVER", `TideCaller spawn error jobId=${jobId}: ${err.message}`);
  });

  return job;
}

/** Inicia processo detached (fire-and-forget). */
function spawnDetached(cmd, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    logger.debug("SERVER", `spawn: ${cmd} ${args.join(" ")}`, { cwd });
    const proc = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
    proc.unref();
    // Pipe output to logger so it appears in log file
    if (proc.stdout) {
      let buf = "";
      proc.stdout.on("data", chunk => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        lines.forEach(l => { if (l.trim()) logger.info("TRANSPORTER", l.trim()); });
      });
      proc.stdout.on("end", () => { if (buf.trim()) logger.info("TRANSPORTER", buf.trim()); });
    }
    if (proc.stderr) {
      let ebuf = "";
      proc.stderr.on("data", chunk => {
        ebuf += chunk.toString();
        const lines = ebuf.split("\n");
        ebuf = lines.pop();
        lines.forEach(l => { if (l.trim()) logger.warn("TRANSPORTER", l.trim()); });
      });
      proc.stderr.on("end", () => { if (ebuf.trim()) logger.warn("TRANSPORTER", ebuf.trim()); });
    }
    proc.on("error", reject);
    resolve({ status: "started", pid: proc.pid });
  });
}

const SEARCH_TIMEOUT_MS = 60_000;

/** Wraps a search promise with a timeout to prevent the route hanging forever. */
function withSearchTimeout(promise, label = "") {
  const startedAt = Date.now();
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const elapsed = Date.now() - startedAt;
        reject(new Error(
          `Tempo esgotado (${elapsed}ms, limite ${SEARCH_TIMEOUT_MS}ms) na busca "${label}". ` +
          `Verifique nos logs [STORMBRINGER] se apareceu "Jackett buscando" (chamada real ao Jackett, provavelmente indexer lento) ` +
          `ou "Jackett NÃO disponível" (caiu no scraper público por falta de API key).`
        ));
      }, SEARCH_TIMEOUT_MS)
    ),
  ]);
}

export function toolsRouter(router) {
  // ── POST /api/tools/stormbringer/search ──────────────────────────────────
  router.post("/tools/stormbringer/search", async (req, res) => {
    const { artist, album } = req.body || {};
    if (!artist?.trim()) return res.status(400).json({ error: "'artist' é obrigatório" });

    try {
      logger.info("SERVER", `Stormbringer search music: "${artist}" / "${album || ""}"`);
      const ts = await getTorrentSearch();
      const results = await withSearchTimeout(ts.searchMusic(artist.trim(), album?.trim() || null), `music: ${artist}`);

      const limit = Math.min(parseInt(req.body?.limit) || 100, 200);
      res.json(
        results.slice(0, limit).map((r) => ({
          title:    r.title    || "",
          size:     r.size     || "–",
          seeds:    typeof r.seeds === "number" ? r.seeds : 0,
          peers:    typeof r.peers === "number" ? r.peers : 0,
          provider: r.provider || "–",
          magnet:   r.magnet   || null,
          link:     r.link     || null,
        }))
      );
    } catch (err) {
      const detail = err.response?.data ?? err.cause ?? err.message ?? String(err);
      logger.error("SERVER", `Stormbringer search error: ${JSON.stringify(detail)}`);
      res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    }
  });

  // ── POST /api/tools/stormbringer/search/movie ────────────────────────────
  // Body: { title, year? }
  router.post("/tools/stormbringer/search/movie", async (req, res) => {
    const { title, year } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: "'title' é obrigatório" });
    try {
      logger.info("SERVER", `Stormbringer search movie: "${title}" ${year || ""}`);
      const ts = await getTorrentSearch();
      const results = await withSearchTimeout(ts.searchMovies(title.trim(), year ? parseInt(year) : null), `movie: ${title}`);
      const limit = Math.min(parseInt(req.body?.limit) || 100, 200);
      res.json(
        results.slice(0, limit).map((r) => ({
          title:    r.title    || "",
          size:     r.size     || "–",
          seeds:    typeof r.seeds === "number" ? r.seeds : 0,
          peers:    typeof r.peers === "number" ? r.peers : 0,
          provider: r.provider || "–",
          magnet:   r.magnet   || null,
          link:     r.link     || null,
        }))
      );
    } catch (err) {
      const detail = err.response?.data ?? err.cause ?? err.message ?? String(err);
      logger.error("SERVER", `Stormbringer movie search error: ${JSON.stringify(detail)}`);
      res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    }
  });

  // ── POST /api/tools/stormbringer/search/series ───────────────────────────
  // Body: { title, season?, episode? }
  router.post("/tools/stormbringer/search/series", async (req, res) => {
    const { title, season, episode } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: "'title' é obrigatório" });
    try {
      const s = season  ? parseInt(season)  : null;
      const e = episode ? parseInt(episode) : null;
      logger.info("SERVER", `Stormbringer search series: "${title}" S${s ?? '?'}E${e ?? '?'}`);
      const ts = await getTorrentSearch();
      const results = await withSearchTimeout(ts.searchSeries(title.trim(), s, e), `series: ${title}`);
      const limit = Math.min(parseInt(req.body?.limit) || 100, 200);
      res.json(
        results.slice(0, limit).map((r) => ({
          title:    r.title    || "",
          size:     r.size     || "–",
          seeds:    typeof r.seeds === "number" ? r.seeds : 0,
          peers:    typeof r.peers === "number" ? r.peers : 0,
          provider: r.provider || "–",
          magnet:   r.magnet   || null,
          link:     r.link     || null,
        }))
      );
    } catch (err) {
      const detail = err.response?.data ?? err.cause ?? err.message ?? String(err);
      logger.error("SERVER", `Stormbringer series search error: ${JSON.stringify(detail)}`);
      res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    }
  });

  // ── GET /api/tools/stormbringer/feeds ────────────────────────────────────
  router.get("/tools/stormbringer/feeds", (_req, res) => {
    try {
      const config = loadStormbringerConfig();
      res.json(config.music?.feeds || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/stormbringer/feeds/browse ──────────────────────────────
  router.get("/tools/stormbringer/feeds/browse", async (_req, res) => {
    try {
      const MusicFeedTracker = await getMusicFeedTracker();
      const tracker = new MusicFeedTracker(loadStormbringerConfig());
      const items = await tracker.browseFeeds(30);
      res.json(items);
    } catch (err) {
      logger.error("SERVER", `Stormbringer browse error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/stormbringer/feeds/check ───────────────────────────────
  router.get("/tools/stormbringer/feeds/check", async (_req, res) => {
    try {
      const MusicFeedTracker = await getMusicFeedTracker();
      const tracker = new MusicFeedTracker(loadStormbringerConfig());
      const releases = await tracker.checkForNewReleases();
      res.json(releases);
    } catch (err) {
      logger.error("SERVER", `Stormbringer check error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/stormbringer/tracked ───────────────────────────────────
  router.get("/tools/stormbringer/tracked", async (_req, res) => {
    try {
      const MusicFeedTracker = await getMusicFeedTracker();
      const tracker = new MusicFeedTracker(loadStormbringerConfig());
      res.json(tracker.listArtists());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/tools/stormbringer/tracked ──────────────────────────────────
  // Body: { name, genre? }
  router.post("/tools/stormbringer/tracked", async (req, res) => {
    const { name, genre } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "'name' é obrigatório" });
    try {
      const MusicFeedTracker = await getMusicFeedTracker();
      const tracker = new MusicFeedTracker(loadStormbringerConfig());
      tracker.addArtist(name.trim(), genre?.trim() || null);
      res.json({ ok: true, artists: tracker.listArtists() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/tools/stormbringer/download ─────────────────────────────────
  // Body: { magnet, artist?, album? }  — baixa torrent de MÚSICA
  router.post("/tools/stormbringer/download", async (req, res) => {
    const { magnet, artist, album } = req.body || {};
    if (!magnet?.trim()) return res.status(400).json({ error: "'magnet' é obrigatório" });
    logger.info("SERVER", `Stormbringer download recebido — tipo=${typeof magnet} valor=${String(magnet).slice(0, 120)}`);
    try {
      const torrentId = await resolveTorrentId(magnet.trim());
      const dm = await getDmInstance();
      dm.addTorrent(torrentId, "music", {
        artist: artist?.trim() || "Unknown",
        album:  album?.trim()  || "Unknown",
      }).catch(err => logger.error("SERVER", `Stormbringer DL error: ${err.message}`));
      res.json({ ok: true, status: "downloading", magnet: magnet.trim() });
    } catch (err) {
      const cause = err.cause ?? err;
      const detail = cause?.code ?? cause?.message ?? String(cause);
      logger.error("SERVER", `Stormbringer download error: ${detail} | magnet_start=${String(magnet).slice(0,80)}`);
      res.status(500).json({ error: detail });
    }
  });

  // ── POST /api/tools/stormbringer/download/media ───────────────────────────
  // Body: { magnet, type: "movie"|"series", title? }
  router.post("/tools/stormbringer/download/media", async (req, res) => {
    const { magnet, type, title } = req.body || {};
    if (!magnet?.trim()) return res.status(400).json({ error: "'magnet' é obrigatório" });
    if (!type || !['movie','series'].includes(type)) return res.status(400).json({ error: "'type' deve ser 'movie' ou 'series'" });
    try {
      logger.info("SERVER", `Stormbringer download media: type=${type} title="${title || ""}"`);
      const torrentId = await resolveTorrentId(magnet.trim());
      const dm = await getDmInstance();
      dm.addTorrent(torrentId, type, {
        title: title?.trim() || "Unknown",
      }).catch(err => logger.error("SERVER", `Stormbringer media DL error: ${err.message}`));
      res.json({ ok: true, status: "downloading", type, magnet: magnet.trim() });
    } catch (err) {
      logger.error("SERVER", `Stormbringer media download error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/tools/stormbringer/download/:infoHash ────────────────────
  // Query: ?deleteFiles=true  — também apaga os arquivos baixados do disco
  router.delete("/tools/stormbringer/download/:infoHash", async (req, res) => {
    const { infoHash } = req.params;
    const deleteFiles = req.query.deleteFiles === 'true';
    if (!infoHash?.trim()) return res.status(400).json({ error: "'infoHash' é obrigatório" });
    try {
      const dm = await getDmInstance();
      dm.removeTorrent(infoHash.trim(), deleteFiles);
      logger.info("SERVER", `Stormbringer remove: ${infoHash} (deleteFiles=${deleteFiles})`);
      res.json({ ok: true, deleteFiles });
    } catch (err) {
      logger.error("SERVER", `Stormbringer remove error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/tidecaller/token/check ─────────────────────────────────
  router.get("/tools/tidecaller/token/check", (_req, res) => {
    const proc = spawn("bash", ["scripts/refresh_token.sh", "--check"], { cwd: TIDECALLER_DIR });
    let output = "";
    proc.stdout.on("data", d => { output += d.toString(); });
    proc.stderr.on("data", d => { output += d.toString(); });
    proc.on("close", code => {
      res.json({ valid: code === 0, message: output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim() });
    });
    proc.on("error", err => res.status(500).json({ error: err.message }));
  });

  // ── POST /api/tools/tidecaller/token/start-oauth ──────────────────────────
  // Body: { force?: boolean }  →  inicia fluxo OAuth; retorna { sessionId, url, userCode }
  //   ou  { sessionId, status: "done" }  quando o auto-refresh não precisa de interação
  router.post("/tools/tidecaller/token/start-oauth", (req, res) => {
    const { force = false } = req.body || {};
    const sessionId = randomUUID();
    // --json: Python emite JSON lines em vez de texto/OSC8
    const args = ["scripts/refresh_token.sh", "--json"];
    if (force) args.push("--force");

    const proc = spawn("bash", args, { cwd: TIDECALLER_DIR });
    const session = { proc, status: "pending", url: null, userCode: null, output: "" };
    _oauthSessions.set(sessionId, session);

    let responded = false;
    const respond = (data) => { if (!responded) { responded = true; res.json(data); } };

    let lineBuf = "";
    proc.stdout.on("data", chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // guarda linha incompleta para o próximo chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        session.output += trimmed + "\n";
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === "oauth_url") {
            session.url      = msg.url;
            session.userCode = msg.user_code;
            respond({ sessionId, url: msg.url, userCode: msg.user_code });
          } else if (msg.type === "done") {
            session.status = "done";
            respond({ sessionId, url: session.url, userCode: session.userCode, status: "done" });
          } else if (msg.type === "error") {
            session.status = "error";
            respond({ sessionId, error: msg.message, status: "error" });
          }
        } catch {} // linhas não-JSON (banner shell, debug) são ignoradas silenciosamente
      }
    });

    proc.stderr.on("data", chunk => { session.output += chunk.toString(); });

    proc.on("close", code => {
      session.status = code === 0 ? "done" : "error";
      // Auto-refresh sem OAuth: processo terminou sem emitir oauth_url
      respond({ sessionId, url: session.url, userCode: session.userCode, status: session.status });
      setTimeout(() => _oauthSessions.delete(sessionId), 5 * 60 * 1000);
    });

    proc.on("error", err => {
      session.status = "error";
      respond({ error: err.message });
    });

    // Timeout de segurança: responde após 30s caso Python não emita JSON esperado
    setTimeout(() => respond({ sessionId, url: session.url, userCode: session.userCode, status: "timeout" }), 30000);
  });

  // ── GET /api/tools/tidecaller/token/status/:sessionId ────────────────────
  router.get("/tools/tidecaller/token/status/:sessionId", (req, res) => {
    const session = _oauthSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada ou expirada" });
    const clean = session.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
    res.json({ status: session.status, message: clean.slice(-400).trim() });
  });

  // ── GET /api/tools/stormbringer/downloads ────────────────────────────────
  router.get("/tools/stormbringer/downloads", async (_req, res) => {
    try {
      // Se o DM já estiver iniciado, retorna dados em memória (tempo real)
      if (_dmInstance) {
        const torrents = _dmInstance.getActiveTorrents().map(t => ({
          infoHash:      t.infoHash,
          name:          t.name,
          type:          t.type,
          status:        t.status,
          progress:      t.progress,
          downloaded:    t.downloaded,
          total:         t.total,
          downloadSpeed: t.downloadSpeed,
          uploadSpeed:   t.uploadSpeed,
          peers:         t.peers,
          startTime:     t.startTime,
        }));
        return res.json({ torrents, lastUpdate: Date.now() });
      }
      // Fallback: lê do arquivo de estado (DM ainda não iniciado)
      if (!existsSync(SB_STATE_FILE)) return res.json({ torrents: [], lastUpdate: null });
      const raw = JSON.parse(readFileSync(SB_STATE_FILE, "utf8"));
      res.json(raw);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/tidecaller/downloads ────────────────────────────────
  router.get("/tools/tidecaller/downloads", (_req, res) => {
    const jobs = Array.from(_tidalJobs.values());
    res.json(jobs);
  });

  // ── GET /api/tools/tidecaller/artist/search?q=QUERY ───────────────────────
  router.get("/tools/tidecaller/artist/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "'q' é obrigatório" });
    try {
      const artists = await tidalQuery(["search-artists", q]);
      res.json(Array.isArray(artists) ? artists : []);
    } catch (err) {
      logger.error("SERVER", `TideCaller artist search error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/tidecaller/artist/:id/albums ──────────────────────────
  router.get("/tools/tidecaller/artist/:id/albums", async (req, res) => {
    try {
      const albums = await tidalQuery(["list-albums", req.params.id]);
      res.json(Array.isArray(albums) ? albums : []);
    } catch (err) {
      logger.error("SERVER", `TideCaller list albums error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/tools/tidecaller/artist/download-albums ────────────────────
  // Body: { albums: [{id, name}], artistName? }
  router.post("/tools/tidecaller/artist/download-albums", async (req, res) => {
    const { albums, artistName } = req.body || {};
    if (!Array.isArray(albums) || !albums.length) {
      return res.status(400).json({ error: "'albums' deve ser array não vazio" });
    }
    const ids = albums.map(a => String(a.id || a));
    const albumMeta = Object.fromEntries(albums.map(a => [String(a.id || a), a.name || a.id]));

    const job = startTidalAlbumJob(ids, albumMeta, artistName);
    res.json({ ok: true, jobId: job.jobId, status: "running", count: ids.length, albumIds: ids });
  });

  // ── POST /api/tools/tidecaller/album/download-url ────────────────────────
  // Body: { url }  — baixa um álbum a partir de um link do Tidal
  router.post("/tools/tidecaller/album/download-url", async (req, res) => {
    const { url } = req.body || {};
    if (!url?.trim()) return res.status(400).json({ error: "'url' é obrigatório" });

    const albumId = parseTidalAlbumId(url);
    if (!albumId) {
      return res.status(400).json({
        error: "Link inválido — informe um link de álbum do Tidal (ex.: https://tidal.com/browse/album/12345678)",
      });
    }

    // Metadados são best-effort: o download roda pelo mesmo caminho do fluxo por
    // artista (download-albums ID), então uma falha aqui só custa o nome bonito.
    let name = `Álbum ${albumId}`;
    let artistName = null;
    try {
      const info = await tidalQuery(["album-info", albumId]);
      if (info?.name)   name       = info.name;
      if (info?.artist) artistName = info.artist;
    } catch (err) {
      logger.warn("SERVER", `TideCaller album-info falhou para ${albumId}: ${err.message}`);
    }

    const job = startTidalAlbumJob([albumId], { [albumId]: name }, artistName);
    logger.info("SERVER", `TideCaller download por link — album=${albumId} "${name}"`);
    res.json({ ok: true, jobId: job.jobId, status: "running", albumId, name, artistName });
  });

  // ── POST /api/tools/tidecaller/download ──────────────────────────────────
  // Body: { url? } OU { artist, album?, quality? }
  router.post("/tools/tidecaller/download", async (req, res) => {
    const { url, artist, album, quality = "3" } = req.body || {};
    if (!url?.trim() && !artist?.trim()) {
      return res.status(400).json({ error: "'url' ou 'artist' é obrigatório" });
    }

    try {
      let args, label;
      if (url?.trim()) {
        args  = ["-q", String(quality), "url", url.trim()];
        label = url.trim();
      } else {
        const query = album?.trim() ? `${artist.trim()} ${album.trim()}` : artist.trim();
        args  = ["search", "tidal", album?.trim() ? "album" : "artist", query, "-f"];
        label = query;
      }

      const result = await spawnDetached("bash", ["scripts/rip.sh", ...args], TIDECALLER_DIR);
      logger.info("SERVER", `TideCaller download iniciado: ${label}`);
      res.json({ ...result, message: `Download iniciado: ${label}` });
    } catch (err) {
      logger.error("SERVER", `TideCaller download error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/tools/transporter/run ──────────────────────────────────────
  // Body: { type: "music" | "movies" | "series" | "all" }
  router.post("/tools/transporter/run", async (req, res) => {
    const { type = "music" } = req.body || {};
    try {
      const run = runTransporter(type, { auto: false });
      if (!run) return res.status(409).json({ error: `Transporter (${type}) já está em andamento` });
      res.json({ ok: true, id: run.id, message: `Transporter iniciado — movendo ${type}` });
    } catch (err) {
      logger.error("SERVER", `Transporter error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/transporter/pending ──────────────────────────────────────
  router.get("/tools/transporter/pending", (_req, res) => {
    const _dl = process.env.DOWNLOADS_DIR || "/downloads";
    const sources = [
      { name: "TideCaller (Tidal)",     type: "music",  icon: "🌊", path: join(_dl, "tidecaller") },
      { name: "Stormbringer (música)",  type: "music",  icon: "⚡", path: join(_dl, "stormbringer", "musicas") },
      { name: "Stormbringer (filmes)",  type: "movies", icon: "🎬", path: join(_dl, "stormbringer", "filmes") },
      { name: "Stormbringer (séries)", type: "tv",     icon: "📺", path: join(_dl, "stormbringer", "series") },
    ];
    const result = sources.map(src => {
      let items = [];
      try {
        if (existsSync(src.path)) {
          items = readdirSync(src.path)
            .filter(n => !n.startsWith('.'))
            .sort();
        }
      } catch {}
      return { name: src.name, type: src.type, icon: src.icon, count: items.length, items };
    });
    res.json(result);
  });

  // ── GET /api/tools/queue — fila unificada (torrent + tidal + transporter) ──
  router.get("/tools/queue", (_req, res) => {
    const items = [];
    try {
      const torrents = _dmInstance ? _dmInstance.getActiveTorrents() : [];
      for (const t of torrents) {
        items.push({
          source: "torrent", id: t.infoHash, title: t.name, type: t.type,
          status: t.status, pct: Math.round(t.progress ?? 0),
          speed: t.downloadSpeed, peers: t.peers, startedAt: t.startTime,
        });
      }
    } catch { /* DM não iniciado — segue sem torrents */ }
    for (const j of _tidalJobs.values()) {
      const done = j.albums.filter(a => a.status === "done").length;
      const total = j.albums.length || 1;
      items.push({
        source: "tidal", id: j.jobId,
        title: j.artistName ? `TideCaller — ${j.artistName}` : "TideCaller — álbuns",
        status: j.status, pct: Math.round((done / total) * 100),
        stage: `${done}/${total} álbuns`, startedAt: j.startedAt,
        albums: j.albums, lastError: j.lastError,
      });
    }
    for (const r of _transporterRuns.values()) {
      items.push({
        source: "transporter", id: r.id, title: r.title,
        status: r.status, startedAt: r.startedAt, auto: r.auto, exitCode: r.exitCode,
      });
    }
    res.json({
      items,
      history: _readJsonSafe(_QUEUE_HISTORY_FILE, []).slice(0, 30),
      autoTransporter: _autoTransporter,
      updatedAt: Date.now(),
    });
  });

  // ── POST /api/tools/settings — toggles da fila (persistido em settings.json) ──
  router.post("/tools/settings", (req, res) => {
    const { autoTransporter } = req.body || {};
    if (typeof autoTransporter === "boolean") {
      _autoTransporter = autoTransporter;
      const s = _readJsonSafe(_SETTINGS_FILE, {});
      s.autoTransporter = _autoTransporter;
      _writeJsonSafe(_SETTINGS_FILE, s);
      logger.info("SERVER", `autoTransporter = ${_autoTransporter}`);
    }
    res.json({ autoTransporter: _autoTransporter });
  });

  // ── POST /api/tools/queue/tidal/:id/cancel — mata o processo do job ────────
  router.post("/tools/queue/tidal/:id/cancel", (req, res) => {
    const job = _tidalJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job não encontrado" });
    if (job.status !== "running") return res.status(409).json({ error: `Job já finalizado (${job.status})` });
    const proc = _tidalProcs.get(req.params.id);
    if (proc) proc.kill("SIGTERM");
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    _pushQueueHistory({ source: "tidal", id: job.jobId, title: job.artistName || "TideCaller — álbuns", status: "cancelled", finishedAt: job.finishedAt });
    logger.warn("SERVER", `TideCaller job cancelado jobId=${req.params.id}`);
    res.json({ ok: true });
  });

  // ── POST /api/tools/queue/tidal/:id/retry — re-baixa os álbuns que falharam ─
  router.post("/tools/queue/tidal/:id/retry", (req, res) => {
    const job = _tidalJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job não encontrado" });
    const failed = job.albums.filter(a => a.status === "error").map(a => a.id);
    if (!failed.length) return res.status(409).json({ error: "Nenhum álbum com erro para re-tentar" });
    const meta = Object.fromEntries(job.albums.map(a => [a.id, a.name]));
    const newJob = startTidalAlbumJob(failed, meta, job.artistName);
    res.json({ jobId: newJob.jobId, albums: failed.length });
  });

  return router;
}
