import fs from "fs";
import path from "path";
import { moveFile, ensureDir, removeIfEmpty } from "./filesystem.js";
import { sanitizeName } from "./strings.js";

/** Extensions considered video files */
const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".wmv"]);

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
 * Used by Transporter's run.js with the --movies flag.
 */
export class MovieOrganizer {
  /**
   * @param {string} destDir  Plex movies library root (e.g. /plex/movies)
   * @param {{dryRun?: boolean, verbose?: boolean}} opts
   */
  constructor(destDir, opts = {}) {
    this.destDir = destDir;
    this.opts = { dryRun: false, verbose: false, ...opts };
    this._stats = { moved: 0, skipped: 0, errors: 0 };
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
   * Scans sourceDir for video files (top-level loose files + single-level
   * subdirectory movies) and moves each one to destDir in Plex format.
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

    if (!this.opts.dryRun) {
      ensureDir(destFolder);
      if (!fs.existsSync(destFile)) {
        try {
          moveFile(filePath, destFile);
          this._stats.moved++;
        } catch (err) {
          console.error(`[MovieOrganizer] Error moving "${filename}": ${err.message}`);
          this._stats.errors++;
        }
      } else {
        this._log(`  Already exists, skipping: ${destFile}`);
        this._stats.skipped++;
      }
    } else {
      this._stats.moved++;
    }
  }

  /**
   * Process a movie subdirectory — finds the primary video file inside.
   * @private
   */
  _processMovieFolder(folderPath, folderName) {
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    const videoFiles = items
      .filter(
        (e) =>
          e.isFile() &&
          VIDEO_EXTS.has(path.extname(e.name).toLowerCase())
      )
      .sort((a, b) => {
        // Prefer the largest file (main feature over extras/samples)
        const aSize = fs.statSync(path.join(folderPath, a.name)).size;
        const bSize = fs.statSync(path.join(folderPath, b.name)).size;
        return bSize - aSize;
      });

    if (videoFiles.length === 0) {
      this._log(`No video files in folder: ${folderName}`);
      return;
    }

    const primaryFile = videoFiles[0];
    const primaryPath = path.join(folderPath, primaryFile.name);

    // Try parsing the filename; fall back to folder name
    let parsed = this.parseMovieFile(primaryFile.name);
    if (!parsed) {
      parsed = this.parseMovieFile(folderName + path.extname(primaryFile.name));
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
      `  ${folderName}/${primaryFile.name}  →  ${path.relative(this.destDir, destFile)}`
    );

    if (!this.opts.dryRun) {
      ensureDir(destFolder);
      if (!fs.existsSync(destFile)) {
        try {
          moveFile(primaryPath, destFile);
          this._stats.moved++;
          removeIfEmpty(folderPath);
        } catch (err) {
          console.error(
            `[MovieOrganizer] Error moving "${folderName}": ${err.message}`
          );
          this._stats.errors++;
        }
      } else {
        this._log(`  Already exists, skipping: ${destFile}`);
        this._stats.skipped++;
      }
    } else {
      this._stats.moved++;
    }
  }

  // ─── getStats() / printStats() ───────────────────────────────────────────

  /** Returns current processing statistics */
  getStats() {
    return { ...this._stats };
  }

  /** Prints a summary of what was moved */
  printStats() {
    console.log(
      `[MovieOrganizer] moved=${this._stats.moved} skipped=${this._stats.skipped} errors=${this._stats.errors}`
    );
  }

  _log(...args) {
    if (this.opts.verbose) console.log("[MovieOrganizer]", ...args);
  }
}
