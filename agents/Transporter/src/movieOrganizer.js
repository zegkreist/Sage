import fs from "fs";
import path from "path";
import { moveFile, ensureDir, removeIfEmpty } from "./filesystem.js";
import { sanitizeName } from "./strings.js";

/** Extensions considered video files */
const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".wmv"]);

/** Subtitle sidecar extensions that accompany the movie */
const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt"]);

 /** Metadata/provenance junk produced by torrent releases */
const JUNK_EXTS = new Set([".nfo", ".txt", ".url", ".nzb", ".torrent"]);

/** Cover/fanart images shipped in releases — junk, exceto o poster escolhido */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp"]);

/** Nomes canônicos de capa que viram poster no destino */
const POSTER_NAMES = new Set(["folder.jpg", "poster.jpg", "cover.jpg"]);

/** Vídeo menor que isso é sample/proof, não o filme */
const MIN_FEATURE_BYTES = 100 * 1024 * 1024;

/** Padrões de nome de lixo em releases de torrent */
const SAMPLE_RE = /sample|proof|rarbg|ettv|tgx|yts|eztv/i;

/** Quality/codec tags stripped from torrent filenames */
const QUALITY_RE =
  /\b(1080p|720p|480p|2160p|4K|4k|BluRay|Blu-Ray|WEB-DL|WEBRip|HDRip|HDTV|DVDRip|x264|x265|HEVC|AVC|AAC|DTS|AC3|DD5\.1|YIFY|RARBG|GalaxyTV|TGx|XviD|H\.264|H\.265|Remux|HDR|SDR).*$/i;

/**
 * MovieOrganizer
 *
 * Moves movie files/folders from a download source directory into a
 * Plex-organised destination:
 *
 *   downloads/filmes/Avatar.2009.1080p.mkv
 *     → movies/Avatar (2009)/Avatar (2009).mkv
 *
 *   downloads/filmes/The.Dark.Knight.2008.BluRay/The.Dark.Knight.2008.mkv
 *     → movies/The Dark Knight (2008)/The Dark Knight (2008).mkv
 *
 * Depois de mover o vídeo principal, o conteúdo que sobrou na pasta do
 * release é classificado:
 *   - acompanha o filme → legendas do mesmo basename e poster, movidos junto
 *   - lixo de release   → .nfo/.txt/.url/.torrent/imagens/samples, apagado
 *   - residual legítimo → mantido e REPORTADO no fim (nada silencioso)
 * A pasta de origem só sobrevive se tiver residual legítimo.
 *
 * Used by Transporter's run.js with the --movies flag.
 */
export class MovieOrganizer {
  /**
   * @param {string} destDir  Plex movies library root (e.g. /plex/movies)
   * @param {{dryRun?: boolean, verbose?: boolean}} opts
   */
  constructor(destDir, opts = {}) {
    this.destDir = destDir;
    this.opts = { dryRun: false, verbose: false, minFeatureBytes: MIN_FEATURE_BYTES, ...opts };
    this._stats = {
      moved: 0,
      skipped: 0,
      errors: 0,
      duplicates: 0,
      junkDeleted: 0,
      leftoverFolders: 0,
    };
  }

  // ─── parseMovieFile() ────────────────────────────────────────────────────

  /**
   * Parses a movie filename into structured data.
   * Returns null for non-video files or empty strings.
   *
   * @param {string} filename
   * @returns {{title: string, year: string|null, imdbId: string|null, tmdbId: string|null, ext: string}|null}
   */
  parseMovieFile(filename) {
    if (!filename) return null;

    const ext = path.extname(filename).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return null;

    let base = path.basename(filename, ext);

    // Extract {imdb-ttXXX} and {tmdb-XXX} tags
    let imdbId = null;
    let tmdbId = null;

    const imdbMatch = base.match(/\{imdb-(tt\d+)\}/i);
    if (imdbMatch) {
      imdbId = imdbMatch[1];
      base = base.replace(imdbMatch[0], "").trim();
    }
    const tmdbMatch = base.match(/\{tmdb-(\d+)\}/i);
    if (tmdbMatch) {
      tmdbId = tmdbMatch[1];
      base = base.replace(tmdbMatch[0], "").trim();
    }

    // Detect dot/underscore-separated (no spaces)
    const isDotSeparated = !base.includes(" ");

    // Extract year — supports (2009), [2009], plain 2009 in dot/space context
    const yearMatch = base.match(
      /[\[\(](\d{4})[\]\)]|(?:^|[\s._])(\d{4})(?:[\s._]|$)/
    );
    let year = null;
    let yearIndex = -1;

    if (yearMatch) {
      year = yearMatch[1] || yearMatch[2];
      yearIndex = yearMatch.index;
      const y = parseInt(year, 10);
      if (y < 1888 || y > 2100) {
        year = null;
        yearIndex = -1;
      }
    }

    // Title = everything before year
    let title = yearIndex >= 0 ? base.substring(0, yearIndex) : base;

    // Remove quality tags
    title = title.replace(QUALITY_RE, "");

    // Normalize separators
    if (isDotSeparated) {
      title = title.replace(/[._]/g, " ");
    }
    title = title.replace(/[\s.\-–_]+$/, "").replace(/\s+/g, " ").trim();

    if (!title) return null;

    return { title, year, imdbId, tmdbId, ext };
  }

  // ─── toPlexMovieName() ───────────────────────────────────────────────────

  /**
   * Formats a canonical Plex movie name: "Title (Year)" with Title Case.
   * Used as both the folder name and the file base name.
   */
  toPlexMovieName(title, year) {
    // Strip existing (YYYY) from title
    const rawTitle = title.replace(/\s*\(\d{4}\)/g, "").trim();
    // Apply Title Case (skip words that are all-caps acronyms)
    const cased = rawTitle.replace(/\S+/g, (w) => {
      // preserve all-caps abbreviations like "USA", "DC"
      if (w === w.toUpperCase() && w.length > 1) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
    const clean = cased.replace(/\s+/g, " ").trim();
    return year ? `${clean} (${year})` : clean;
  }

  // ─── processSource() ────────────────────────────────────────────────────

  /**
   * Scans sourceDir for video files (top-level loose files + movie folders,
   * com busca do vídeo principal até 1 nível de subpasta p/ releases
   * multi-CD) and moves each one to destDir in Plex format.
   * No fim, limpa lixo solto na raiz e reporta todo residual.
   *
   * @param {string} sourceDir  Download source folder (e.g. downloads/filmes/)
   * @param {string} label      Label for logging
   */
  processSource(sourceDir, label = "") {
    if (!fs.existsSync(sourceDir)) {
      this._log(`Source not found, skipping: ${sourceDir}`);
      return;
    }

    this._log(`Processing ${label} from: ${sourceDir}`);

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(sourceDir, entry.name);

      if (entry.isFile()) {
        this._processVideoFile(entryPath, entry.name);
      } else if (entry.isDirectory()) {
        this._processMovieFolder(entryPath, entry.name);
      }
    }

    this._sweepSource(sourceDir);
  }

  /**
   * Process a loose video file at the source root.
   * @private
   */
  _processVideoFile(filePath, filename) {
    const parsed = this.parseMovieFile(filename);
    if (!parsed) {
      this._log(`Skipping non-video: ${filename}`);
      return;
    }

    const plexName = this.toPlexMovieName(parsed.title, parsed.year);
    let finalName = plexName;
    if (parsed.imdbId) finalName += ` {imdb-${parsed.imdbId}}`;
    else if (parsed.tmdbId) finalName += ` {tmdb-${parsed.tmdbId}}`;

    const destFolder = path.join(this.destDir, sanitizeName(plexName));
    const destFile = path.join(destFolder, sanitizeName(`${finalName}${parsed.ext}`));

    this._log(`  ${filename}  →  ${path.relative(this.destDir, destFile)}`);

    const duplicate = this._isDuplicate(destFile, filename);
    if (duplicate === "partial") return;

    if (!this.opts.dryRun) {
      ensureDir(destFolder);
    }
    if (!duplicate) {
      if (!this._moveFile(filePath, destFile)) return;
      this._stats.moved++;
      // Legendas soltas com o mesmo basename acompanham o filme
      this._moveStemSidecars(path.dirname(filePath), this._stem(filename), destFolder, finalName);
    } else {
      this._deleteFile(filePath, false);
      this._stats.duplicates++;
    }
  }

  /**
   * Process a movie subdirectory — finds the primary video file inside
   * (top-level ou 1 nível de subpasta, ex: CD1/), move para o destino,
   * leva legendas/poster junto, apaga o lixo do release e remove a pasta
   * se não sobrar conteúdo legítimo.
   * @private
   */
  _processMovieFolder(folderPath, folderName) {
    const primary = this._findPrimaryVideo(folderPath);

    if (!primary) {
      this._log(`No video files in folder: ${folderName}`);
      return;
    }

    // Try parsing the filename; fall back to folder name
    let parsed = this.parseMovieFile(primary.name);
    if (!parsed) {
      parsed = this.parseMovieFile(folderName + path.extname(primary.name));
    }
    if (!parsed) {
      this._log(`Could not parse movie name from folder: ${folderName}`);
      return;
    }

    const plexName = this.toPlexMovieName(parsed.title, parsed.year);
    let finalName = plexName;
    if (parsed.imdbId) finalName += ` {imdb-${parsed.imdbId}}`;
    else if (parsed.tmdbId) finalName += ` {tmdb-${parsed.tmdbId}}`;

    const destFolder = path.join(this.destDir, sanitizeName(plexName));
    const destFile = path.join(destFolder, sanitizeName(`${finalName}${parsed.ext}`));

    this._log(
      `  ${folderName}/${primary.name}  →  ${path.relative(this.destDir, destFile)}`
    );

    const duplicate = this._isDuplicate(destFile, `${folderName}/${primary.name}`);
    if (duplicate === "partial") return;

    if (!this.opts.dryRun) {
      ensureDir(destFolder);
    }
    if (!duplicate) {
      if (!this._moveFile(primary.path, destFile)) return;
      this._stats.moved++;
    } else {
      // Duplicata: origem não tem utilidade (o destino já tem o filme real)
      this._deleteFile(primary.path, false);
      this._stats.duplicates++;
    }

    // Legendas do release + capa acompanham o filme (mesmo em duplicata —
    // podem ser legendas novas para o filme já existente)
    this._moveSidecars(folderPath, primary, destFolder, finalName);

    // Lixo do release (samples, nfo, txt, imagens) sai da origem
    this._deleteJunkIn(folderPath, 2);
    if (!this.opts.dryRun) {
      removeIfEmpty(folderPath);
    }
  }

  // ─── Classificação de sobras ─────────────────────────────────────────────

  /**
   * Verifica se o destino já tem o filme.
   * Retorna "duplicate" (destino real → origem vira duplicata),
   * "partial" (destino de 0 bytes → não mexe na origem) ou null.
   * @private
   */
  _isDuplicate(destFile, originLabel) {
    const st = this._statSafe(destFile);
    if (!st) return null;
    if (st.size === 0) {
      this._log(`  Destino existe mas está vazio (${destFile}) — origem mantida: ${originLabel}`);
      return "partial";
    }
    this._log(`  Já existe no destino — origem tratada como duplicata: ${originLabel}`);
    return "duplicate";
  }

  /**
   * Encontra o vídeo principal da release: maior arquivo de vídeo no
   * top-level ou até 1 nível de subpasta, ignorando samples.
   * @private
   */
  _findPrimaryVideo(folderPath) {
    const candidates = this._walkFiles(folderPath, 1).filter((f) => {
      if (!VIDEO_EXTS.has(path.extname(f.name).toLowerCase())) return false;
      return !SAMPLE_RE.test(this._stem(f.name));
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0];
  }

  /**
   * Move legendas (mesmo basename do vídeo; se nenhuma casar e houver só
   * uma, leva ela como legenda principal) e a capa (folder/poster/cover)
   * para a pasta de destino.
   * @private
   */
  _moveSidecars(folderPath, primary, destFolder, finalName) {
    const primaryStem = this._stem(primary.name);
    const files = this._walkFiles(folderPath, 2);

    // Capa → poster.jpg no destino
    const poster = files.find(
      (f) => f.dir === folderPath && POSTER_NAMES.has(f.name.toLowerCase())
    );
    if (poster) {
      this._moveFile(poster.path, path.join(destFolder, "poster.jpg"));
    }

    // 1) Legendas cujo stem casa com o do vídeo (Movie.en.srt, Movie.pt-br.srt…)
    const subtitles = files.filter(
      (f) => SUBTITLE_EXTS.has(path.extname(f.name).toLowerCase())
    );
    let movedAny = false;
    for (const sub of subtitles) {
      if (!this._matchesStem(sub.name, primaryStem)) continue;
      const suffix = this._stem(sub.name).slice(primaryStem.length); // ".en", "", …
      const destName = sanitizeName(`${finalName}${suffix}${path.extname(sub.name)}`);
      this._moveFile(sub.path, path.join(destFolder, destName));
      movedAny = true;
    }

    // 2) Nenhuma casou mas só há uma legenda (ex: Subs/2_English.srt) → vira a principal
    if (!movedAny && subtitles.length > 0) {
      const stems = new Set(subtitles.map((f) => this._stem(f.name).toLowerCase()));
      if (stems.size === 1) {
        for (const sub of subtitles) {
          const destName = sanitizeName(`${finalName}${path.extname(sub.name)}`);
          this._moveFile(sub.path, path.join(destFolder, destName));
        }
      }
    }
  }

  /**
   * Move sidecars com o mesmo stem (arquivos soltos na raiz do source).
   * @private
   */
  _moveStemSidecars(dir, stem, destFolder, finalName) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!SUBTITLE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      if (!this._matchesStem(entry.name, stem)) continue;
      const suffix = this._stem(entry.name).slice(stem.length);
      const destName = sanitizeName(`${finalName}${suffix}${path.extname(entry.name)}`);
      this._moveFile(path.join(dir, entry.name), path.join(destFolder, destName));
    }
  }

  /**
   * Apaga lixo de release (samples, nfo/txt/url, imagens) dentro de dir
   * até depth níveis. Retorna quantos arquivos foram (ou seriam) apagados.
   * @private
   */
  _deleteJunkIn(dir, depth = 2) {
    let count = 0;
    for (const f of this._walkFiles(dir, depth)) {
      if (!this._isJunkFile(f.name, f.size)) continue;
      if (this._deleteFile(f.path)) count++;
    }
    return count;
  }

  /**
   * Varredura final do source: apaga lixo solto na raiz e reporta todo
   * conteúdo residual que ficou para trás (nada silencioso).
   * @private
   */
  _sweepSource(sourceDir) {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const p = path.join(sourceDir, entry.name);
      const st = this._statSafe(p);
      if (st && this._isJunkFile(entry.name, st.size)) {
        this._deleteFile(p);
      }
    }

    const byDir = new Map();
    for (const f of this._walkFiles(sourceDir, 2)) {
      if (!byDir.has(f.dir)) byDir.set(f.dir, []);
      byDir.get(f.dir).push(f);
    }
    this._stats.leftoverFolders = byDir.size;
    if (byDir.size > 0) {
      console.log(`[MovieOrganizer] ⚠️  ${byDir.size} pasta(s) com conteúdo residual em ${sourceDir}:`);
      for (const [dir, files] of byDir) {
        const bytes = files.reduce((s, f) => s + f.size, 0);
        const names = files.map((f) => f.name).slice(0, 5).join(", ");
        const more = files.length > 5 ? ` +${files.length - 5}` : "";
        console.log(`[MovieOrganizer]   • ${path.relative(sourceDir, dir) || "."} — ${files.length} arquivo(s), ${(bytes / 1048576).toFixed(1)} MB: ${names}${more}`);
      }
    }
  }

  // ─── File helpers ────────────────────────────────────────────────────────

  _stem(name) {
    return path.basename(name, path.extname(name));
  }

  _statSafe(p) {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  }

  _matchesStem(name, stem) {
    const f = this._stem(name).toLowerCase();
    const s = stem.toLowerCase();
    return f === s || f.startsWith(s + ".");
  }

  _isJunkFile(name, size = 0) {
    const ext = path.extname(name).toLowerCase();
    if (VIDEO_EXTS.has(ext)) {
      return SAMPLE_RE.test(this._stem(name)) || size < this.opts.minFeatureBytes;
    }
    if (SUBTITLE_EXTS.has(ext)) return false;
    return JUNK_EXTS.has(ext) || IMAGE_EXTS.has(ext);
  }

  /** Move com dry-run e contagem de erros. Retorna false em falha real. */
  _moveFile(src, dest) {
    if (this.opts.dryRun) {
      this._log(`  [dry-run] moveria: ${path.basename(src)} → ${path.basename(dest)}`);
      return true;
    }
    try {
      moveFile(src, dest);
      return true;
    } catch (err) {
      console.error(`[MovieOrganizer] Error moving "${path.basename(src)}": ${err.message}`);
      this._stats.errors++;
      return false;
    }
  }

  /** Apaga com dry-run. countAsJunk=false para duplicatas (não é lixo, é cópia). */
  _deleteFile(p, countAsJunk = true) {
    if (this.opts.dryRun) {
      this._log(`  [dry-run] apagaria: ${p}`);
      return true;
    }
    try {
      fs.unlinkSync(p);
      if (countAsJunk) this._stats.junkDeleted++;
      return true;
    } catch (err) {
      console.error(`[MovieOrganizer] Error deleting "${p}": ${err.message}`);
      return false;
    }
  }

  /** Lista arquivos dentro de dir até depth níveis (0 = só o próprio dir). */
  _walkFiles(dir, depth = 1) {
    const out = [];
    const walk = (d, level) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isFile()) {
          const st = this._statSafe(p);
          out.push({ path: p, name: e.name, dir: d, size: st ? st.size : 0 });
        } else if (e.isDirectory() && level < depth) {
          walk(p, level + 1);
        }
      }
    };
    walk(dir, 0);
    return out;
  }

  // ─── getStats() / printStats() ───────────────────────────────────────────

  /** Returns current processing statistics */
  getStats() {
    return { ...this._stats };
  }

  /** Prints a summary of what was moved */
  printStats() {
    const s = this._stats;
    console.log(
      `[MovieOrganizer] moved=${s.moved} skipped=${s.skipped} duplicates=${s.duplicates} junkDeleted=${s.junkDeleted} errors=${s.errors}`
    );
    if (s.leftoverFolders > 0) {
      console.log(
        `[MovieOrganizer] ⚠️  ${s.leftoverFolders} pasta(s) com residual legítimo — ver relatório acima`
      );
    }
  }

  _log(...args) {
    if (this.opts.verbose) console.log("[MovieOrganizer]", ...args);
  }
}
