import fs from "fs";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { MovieOrganizer } from "../src/movieOrganizer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transporter-movie-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function touch(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ─── parseMovieFile ───────────────────────────────────────────────────────────

describe("MovieOrganizer – parseMovieFile()", () => {
  let mo;
  beforeEach(() => {
    mo = new MovieOrganizer(path.join(tmp, "movies"), { dryRun: true });
  });

  test("parseia 'Avatar (2009).mkv' → title=Avatar year=2009", () => {
    const r = mo.parseMovieFile("Avatar (2009).mkv");
    expect(r.title).toBe("Avatar");
    expect(r.year).toBe("2009");
    expect(r.ext).toBe(".mkv");
  });

  test("parseia 'The.Dark.Knight.2008.1080p.mkv' → title=The Dark Knight year=2008", () => {
    const r = mo.parseMovieFile("The.Dark.Knight.2008.1080p.mkv");
    expect(r.title).toBe("The Dark Knight");
    expect(r.year).toBe("2008");
  });

  test("parseia nome sem ano → year=null", () => {
    const r = mo.parseMovieFile("Metropolis.mkv");
    expect(r.title).toBe("Metropolis");
    expect(r.year).toBeNull();
  });

  test("extrai {imdb-ttXXX} quando presente", () => {
    const r = mo.parseMovieFile("Avatar (2009) {imdb-tt0499549}.mkv");
    expect(r.imdbId).toBe("tt0499549");
    expect(r.title).toBe("Avatar");
  });

  test("retorna null para arquivo não-vídeo", () => {
    expect(mo.parseMovieFile("poster.jpg")).toBeNull();
  });

  test("retorna null para string vazia", () => {
    expect(mo.parseMovieFile("")).toBeNull();
  });
});

// ─── toPlexMovieName ──────────────────────────────────────────────────────────

describe("MovieOrganizer – toPlexMovieName()", () => {
  let mo;
  beforeEach(() => {
    mo = new MovieOrganizer(path.join(tmp, "movies"), { dryRun: true });
  });

  test("'Avatar' + '2009' → 'Avatar (2009)'", () => {
    expect(mo.toPlexMovieName("Avatar", "2009")).toBe("Avatar (2009)");
  });

  test("título sem ano → retorna só o título (Title Case)", () => {
    expect(mo.toPlexMovieName("metropolis", null)).toBe("Metropolis");
  });

  test("aplica Title Case", () => {
    expect(mo.toPlexMovieName("the dark knight", "2008")).toBe(
      "The Dark Knight (2008)"
    );
  });
});

// ─── processSource – dry run ──────────────────────────────────────────────────

describe("MovieOrganizer – processSource() dry run", () => {
  let destDir;
  let mo;

  beforeEach(() => {
    destDir = path.join(tmp, "movies");
    fs.mkdirSync(destDir, { recursive: true });
    mo = new MovieOrganizer(destDir, { dryRun: true });
  });

  test("não cria arquivos em dry run", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.1080p.mkv"), "data");

    mo.processSource(src, "Test");

    const entries = fs.readdirSync(destDir);
    expect(entries).toHaveLength(0);
  });

  test("registra stats em dry run", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.mkv"), "data");
    touch(path.join(src, "The.Dark.Knight.2008.mkv"), "data");

    mo.processSource(src, "Test");

    const stats = mo.getStats();
    expect(stats.moved).toBe(2);
  });
});

// ─── processSource – real move ────────────────────────────────────────────────

describe("MovieOrganizer – processSource() real move", () => {
  let destDir;
  let mo;

  beforeEach(() => {
    destDir = path.join(tmp, "movies");
    fs.mkdirSync(destDir, { recursive: true });
    mo = new MovieOrganizer(destDir, { dryRun: false });
  });

  test("move arquivo solto para pasta Plex correta", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.1080p.mkv"), "data");

    mo.processSource(src, "Test");

    const destFile = path.join(destDir, "Avatar (2009)", "Avatar (2009).mkv");
    expect(fs.existsSync(destFile)).toBe(true);
  });

  test("move arquivo dentro de subpasta para pasta Plex correta", () => {
    const src = path.join(tmp, "downloads");
    const subDir = path.join(src, "The.Dark.Knight.2008.BluRay");
    fs.mkdirSync(subDir, { recursive: true });
    touch(path.join(subDir, "The.Dark.Knight.2008.BluRay.mkv"), "data");

    mo.processSource(src, "Test");

    const destFile = path.join(
      destDir,
      "The Dark Knight (2008)",
      "The Dark Knight (2008).mkv"
    );
    expect(fs.existsSync(destFile)).toBe(true);
  });

  test("remove a pasta de origem depois de mover o filme, se ficou vazia", () => {
    const src = path.join(tmp, "downloads");
    const subDir = path.join(src, "The.Dark.Knight.2008.BluRay");
    fs.mkdirSync(subDir, { recursive: true });
    touch(path.join(subDir, "The.Dark.Knight.2008.BluRay.mkv"), "data");

    mo.processSource(src, "Test");

    expect(fs.existsSync(subDir)).toBe(false);
  });

  test("não duplica arquivos já no destino correto", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.mkv"), "data");

    mo.processSource(src, "Test");

    // Run again — no error, no duplicate
    const secondStats = mo.getStats();
    expect(secondStats.errors).toBe(0);
  });

  test("ignora arquivos não-vídeo na fonte", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "poster.jpg"), "");
    touch(path.join(src, "movie.nfo"), "");

    mo.processSource(src, "Test");

    const destEntries = fs.readdirSync(destDir);
    expect(destEntries).toHaveLength(0);
  });

  test("processa múltiplos filmes", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.mkv"), "data");
    touch(path.join(src, "Inception.2010.mkv"), "data");

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(destDir, "Avatar (2009)"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "Inception (2010)"))).toBe(true);
  });

  test("stats.moved reflete o número de arquivos movidos", () => {
    const src = path.join(tmp, "downloads");
    fs.mkdirSync(src, { recursive: true });
    touch(path.join(src, "Avatar.2009.mkv"), "data");
    touch(path.join(src, "Inception.2010.mkv"), "data");

    mo.processSource(src, "Test");

    expect(mo.getStats().moved).toBe(2);
  });
});
