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
 *   POST /api/tools/transporter/run            — move downloads para o Plex
 */
import { randomUUID } from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Caminhos absolutos para os agents irmãos no monorepo
const STORMBRINGER_DIR = join(__dirname, "../../../Stormbringer");
const TIDECALLER_DIR   = join(__dirname, "../../../TideCaller");
const TRANSPORTER_DIR  = join(__dirname, "../../../Transporter");

// Carrega config do Stormbringer com paths resolvidos em absoluto
function loadStormbringerConfig() {
  const raw = JSON.parse(readFileSync(join(STORMBRINGER_DIR, "config.json"), "utf8"));
  // Resolver paths relativos para absolutos
  const dl = raw.downloads;
  raw.downloads = {
    baseDir: resolve(STORMBRINGER_DIR, dl.baseDir),
    movies:  resolve(STORMBRINGER_DIR, dl.movies),
    series:  resolve(STORMBRINGER_DIR, dl.series),
    music:   resolve(STORMBRINGER_DIR, dl.music),
  };
  if (raw.music?.trackerFile) {
    raw.music.trackerFile = resolve(STORMBRINGER_DIR, raw.music.trackerFile);
  }
  if (raw.series?.trackerFile) {
    raw.series.trackerFile = resolve(STORMBRINGER_DIR, raw.series.trackerFile);
  }
  return raw;
}

// Lazy-load do singleton TorrentSearch do Stormbringer
let _torrentSearch = null;
async function getTorrentSearch() {
  if (!_torrentSearch) {
    const mod = await import("../../../Stormbringer/src/torrentSearch.js");
    _torrentSearch = mod.default;
  }
  return _torrentSearch;
}

// Lazy-load da classe MusicFeedTracker (não é singleton — instanciar por chamada)
let _MusicFeedTracker = null;
async function getMusicFeedTracker() {
  if (!_MusicFeedTracker) {
    const mod = await import("../../../Stormbringer/src/musicFeedTracker.js");
    _MusicFeedTracker = mod.default;
  }
  return _MusicFeedTracker;
}

// Singleton do DownloadManager — persiste pelo ciclo de vida do processo
let _DownloadManagerClass = null;
let _dmInstance = null;
async function getDmInstance() {
  if (!_DownloadManagerClass) {
    const mod = await import("../../../Stormbringer/src/downloadManager.js");
    _DownloadManagerClass = mod.default;
  }
  if (!_dmInstance) {
    _dmInstance = new _DownloadManagerClass(loadStormbringerConfig());
  }
  return _dmInstance;
}

// Sessões OAuth em andamento (limpas após 5 min)
const _oauthSessions = new Map();

// Jobs do TideCaller em andamento / histórico recente (limpos após 30 min)
const _tidalJobs = new Map();
// Path do state file do Stormbringer
const SB_STATE_FILE = join(STORMBRINGER_DIR, ".download-state.json");

// Python venv do TideCaller
const TC_PYTHON = join(TIDECALLER_DIR, ".venv_tidal", "bin", "python3");
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

/** Inicia processo detached (fire-and-forget). */
function spawnDetached(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    logger.debug("SERVER", `spawn: ${cmd} ${args.join(" ")}`, { cwd });
    const proc = spawn(cmd, args, { cwd, detached: true, stdio: "ignore" });
    proc.unref();
    proc.on("error", reject);
    resolve({ status: "started", pid: proc.pid });
  });
}

export function toolsRouter(router) {
  // ── POST /api/tools/stormbringer/search ──────────────────────────────────
  router.post("/tools/stormbringer/search", async (req, res) => {
    const { artist, album } = req.body || {};
    if (!artist?.trim()) return res.status(400).json({ error: "'artist' é obrigatório" });

    try {
      logger.info("SERVER", `Stormbringer search music: "${artist}" / "${album || ""}"`);
      const ts = await getTorrentSearch();
      const results = await ts.searchMusic(artist.trim(), album?.trim() || null);

      res.json(
        results.slice(0, 15).map((r) => ({
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
      logger.error("SERVER", `Stormbringer search error: ${err.message}`);
      res.status(500).json({ error: err.message });
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
      const results = await ts.searchMovies(title.trim(), year ? parseInt(year) : null);
      res.json(
        results.slice(0, 15).map((r) => ({
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
      logger.error("SERVER", `Stormbringer movie search error: ${err.message}`);
      res.status(500).json({ error: err.message });
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
      const results = await ts.searchSeries(title.trim(), s, e);
      res.json(
        results.slice(0, 15).map((r) => ({
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
      logger.error("SERVER", `Stormbringer series search error: ${err.message}`);
      res.status(500).json({ error: err.message });
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
    try {
      const dm = await getDmInstance();
      dm.addTorrent(magnet.trim(), "music", {
        artist: artist?.trim() || "Unknown",
        album:  album?.trim()  || "Unknown",
      }).catch(err => logger.error("SERVER", `Stormbringer DL error: ${err.message}`));
      res.json({ ok: true, status: "downloading", magnet: magnet.trim() });
    } catch (err) {
      logger.error("SERVER", `Stormbringer download error: ${err.message}`);
      res.status(500).json({ error: err.message });
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
      const dm = await getDmInstance();
      dm.addTorrent(magnet.trim(), type, {
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
    const args = ["scripts/refresh_token.sh"];
    if (force) args.push("--force");

    const proc = spawn("bash", args, { cwd: TIDECALLER_DIR });
    const session = { proc, status: "pending", url: null, userCode: null, output: "" };
    _oauthSessions.set(sessionId, session);

    let responded = false;
    const respond = (data) => { if (!responded) { responded = true; res.json(data); } };

    proc.stdout.on("data", chunk => {
      const text = chunk.toString();
      session.output += text;

      if (!session.url) {
        // URL fica dentro da sequência OSC 8: \x1b]8;;<URL>\x1b\\
        const oscMatch = text.match(/\x1b\]8;;(https?:\/\/[^\x1b]+)\x1b/);
        if (oscMatch) session.url = oscMatch[1].trim();
        // Fallback: URL plain no texto
        if (!session.url) {
          const plainMatch = text.match(/https:\/\/[^\s\x1b]+/);
          if (plainMatch) session.url = plainMatch[0].trim();
        }
      }

      if (!session.userCode) {
        const codeMatch = text.match(/C[oó]digo:\s*([A-Z0-9][A-Z0-9-]+)/i);
        if (codeMatch) session.userCode = codeMatch[1].trim();
      }

      if (session.url && session.userCode) {
        respond({ sessionId, url: session.url, userCode: session.userCode });
      }
    });

    proc.stderr.on("data", chunk => { session.output += chunk.toString(); });

    proc.on("close", code => {
      session.status = code === 0 ? "done" : "error";
      // Auto-refresh sem OAuth: processo terminou sem mostrar URL
      respond({ sessionId, url: session.url, userCode: session.userCode, status: session.status });
      setTimeout(() => _oauthSessions.delete(sessionId), 5 * 60 * 1000);
    });

    proc.on("error", err => {
      session.status = "error";
      respond({ error: err.message });
    });

    // Timeout de segurança: responde após 12s mesmo que nada seja detectado
    setTimeout(() => respond({ sessionId, url: session.url, userCode: session.userCode, status: "timeout" }), 12000);
  });

  // ── GET /api/tools/tidecaller/token/status/:sessionId ────────────────────
  router.get("/tools/tidecaller/token/status/:sessionId", (req, res) => {
    const session = _oauthSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada ou expirada" });
    const clean = session.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
    res.json({ status: session.status, message: clean.slice(-400).trim() });
  });

  // ── GET /api/tools/stormbringer/downloads ────────────────────────────────
  router.get("/tools/stormbringer/downloads", (_req, res) => {
    try {
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
  // Body: { albums: [{id, name}] }
  router.post("/tools/tidecaller/artist/download-albums", async (req, res) => {
    const { albums } = req.body || {};
    if (!Array.isArray(albums) || !albums.length) {
      return res.status(400).json({ error: "'albums' deve ser array não vazio" });
    }
    const ids = albums.map(a => String(a.id || a));
    const albumMeta = Object.fromEntries(albums.map(a => [String(a.id || a), a.name || a.id]));

    const jobId = randomUUID();
    const job = {
      jobId,
      startTime: Date.now(),
      status: "running",
      albums: ids.map(id => ({ id, name: albumMeta[id] || id, status: "pending" })),
    };
    _tidalJobs.set(jobId, job);

    const env = { ...process.env, XDG_CONFIG_HOME: join(TIDECALLER_DIR, "config", ".config") };
    const proc = spawn(TC_PYTHON, [TC_QUERY, "download-albums", ...ids], {
      cwd: TIDECALLER_DIR, env, stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    proc.stdout.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t);
          if (parsed.albumId) {
            const entry = job.albums.find(a => a.id === parsed.albumId);
            if (entry) entry.status = parsed.ok ? "done" : "error";
          } else if (parsed.done) {
            job.status = "done";
          }
        } catch { /* non-JSON line, ignore */ }
      }
    });
    proc.stderr.on("data", chunk => { job.lastError = chunk.toString().slice(-200); });
    proc.on("close", code => {
      job.status = job.status === "running" ? (code === 0 ? "done" : "error") : job.status;
      job.albums.forEach(a => { if (a.status === "pending") a.status = code === 0 ? "done" : "error"; });
      // Limpar após 30 min
      setTimeout(() => _tidalJobs.delete(jobId), 30 * 60 * 1000);
    });
    proc.on("error", err => {
      job.status = "error";
      job.lastError = err.message;
      logger.error("SERVER", `TC download-albums error: ${err.message}`);
    });

    logger.info("SERVER", `TideCaller download-albums jobId=${jobId} albums=${ids.join(", ")}`);
    res.json({ ok: true, jobId, status: "running", count: ids.length, albumIds: ids });
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
    const flagMap = { music: ["--music"], movies: ["--movies"], series: ["--series"], all: [] };
    const flags = flagMap[type] ?? ["--music"];

    try {
      const result = await spawnDetached("node", ["src/run.js", ...flags], TRANSPORTER_DIR);
      logger.info("SERVER", `Transporter iniciado (${type})`);
      res.json({ ...result, message: `Transporter iniciado — movendo ${type}` });
    } catch (err) {
      logger.error("SERVER", `Transporter error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/tools/transporter/pending ──────────────────────────────────────
  router.get("/tools/transporter/pending", (_req, res) => {
    const sources = [
      { name: "TideCaller (Tidal)",     type: "music",  icon: "🌊", path: join(TIDECALLER_DIR, "downloads") },
      { name: "Stormbringer (música)",  type: "music",  icon: "⚡", path: join(STORMBRINGER_DIR, "downloads", "musicas") },
      { name: "Stormbringer (filmes)",  type: "movies", icon: "🎬", path: join(STORMBRINGER_DIR, "downloads", "filmes") },
      { name: "Stormbringer (séries)", type: "tv",     icon: "📺", path: join(STORMBRINGER_DIR, "downloads", "series") },
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

  return router;
}
