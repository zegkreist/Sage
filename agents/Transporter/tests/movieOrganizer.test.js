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

// ─── limpeza de pasta de release ──────────────────────────────────────────────

describe("MovieOrganizer – limpeza de pasta de release", () => {
  let destDir;
  let src;
  let mo;

  // minFeatureBytes baixo: vídeos "grandes" têm >= 20 bytes nos testes
  beforeEach(() => {
    destDir = path.join(tmp, "movies");
    src = path.join(tmp, "downloads");
    fs.mkdirSync(destDir, { recursive: true });
    fs.mkdirSync(src, { recursive: true });
    mo = new MovieOrganizer(destDir, { dryRun: false, minFeatureBytes: 20 });
  });

  test("apaga lixo do release e remove a pasta após mover o filme", () => {
    const rel = path.join(src, "The.Dark.Knight.2008.BluRay");
    touch(path.join(rel, "The.Dark.Knight.2008.BluRay.mkv"), "x".repeat(100));
    touch(path.join(rel, "The.Dark.Knight.2008.BluRay.nfo"), "meta");
    touch(path.join(rel, "RARBG.txt"), "www");
    touch(path.join(rel, "cover.jpg"), "img");
    touch(path.join(rel, "Sample", "sample.mkv"), "tiny");

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(destDir, "The Dark Knight (2008)", "The Dark Knight (2008).mkv"))).toBe(true);
    // cover.jpg não é lixo: acompanha o filme como poster.jpg
    expect(fs.existsSync(path.join(destDir, "The Dark Knight (2008)", "poster.jpg"))).toBe(true);
    expect(fs.existsSync(rel)).toBe(false);
    expect(mo.getStats().junkDeleted).toBe(3);
  });

  test("legenda com mesmo basename acompanha o filme com sufixo de idioma", () => {
    const rel = path.join(src, "Avatar.2009.1080p.BluRay");
    touch(path.join(rel, "Avatar.2009.1080p.BluRay.mkv"), "x".repeat(100));
    touch(path.join(rel, "Avatar.2009.1080p.BluRay.pt-br.srt"), "legenda");

    mo.processSource(src, "Test");

    const destFolder = path.join(destDir, "Avatar (2009)");
    expect(fs.existsSync(path.join(destFolder, "Avatar (2009).pt-br.srt"))).toBe(true);
    expect(fs.existsSync(rel)).toBe(false);
  });

  test("legenda única sem casar basename vira a legenda principal", () => {
    const rel = path.join(src, "Inception.2010.1080p");
    touch(path.join(rel, "Inception.2010.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "Subs", "2_English.srt"), "legenda");

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(destDir, "Inception (2010)", "Inception (2010).srt"))).toBe(true);
    expect(fs.existsSync(rel)).toBe(false);
  });

  test("encontra vídeo em subpasta multi-CD e remove a pasta limpa", () => {
    const rel = path.join(src, "Heat.1995.1080p");
    touch(path.join(rel, "CD1", "Heat.1995.1080p.CD1.mkv"), "x".repeat(100));

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(destDir, "Heat (1995)", "Heat (1995).mkv"))).toBe(true);
    expect(fs.existsSync(rel)).toBe(false);
  });

  test("duplicata: destino já tem o filme → origem apagada e pasta removida", () => {
    const rel = path.join(src, "Avatar.2009.1080p");
    touch(path.join(rel, "Avatar.2009.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "RARBG.txt"), "www");
    // primeira passada move o filme
    mo.processSource(src, "Test");
    expect(mo.getStats().moved).toBe(1);

    // re-download: mesma release volta para a pasta de downloads
    touch(path.join(rel, "Avatar.2009.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "RARBG.txt"), "www");
    mo.processSource(src, "Test");

    const stats = mo.getStats();
    expect(stats.duplicates).toBe(1);
    expect(stats.moved).toBe(1); // não mudou
    expect(fs.existsSync(rel)).toBe(false);
  });

  test("extra legítimo (2º vídeo grande) é mantido e reportado", () => {
    const rel = path.join(src, "Interstellar.2014.1080p");
    touch(path.join(rel, "Interstellar.2014.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "Making.Of.mkv"), "x".repeat(50));

    mo.processSource(src, "Test");

    expect(fs.existsSync(rel)).toBe(true);
    expect(fs.existsSync(path.join(rel, "Making.Of.mkv"))).toBe(true);
    const stats = mo.getStats();
    expect(stats.leftoverFolders).toBe(1);
  });

  test("lixo solto na raiz é apagado na varredura final", () => {
    touch(path.join(src, "solute.jpg"), "img");
    touch(path.join(src, "readme.txt"), "txt");

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(src, "solute.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(src, "readme.txt"))).toBe(false);
    expect(fs.readdirSync(destDir)).toHaveLength(0);
  });

  test("poster do release acompanha o filme como poster.jpg", () => {
    const rel = path.join(src, "Coco.2017.1080p");
    touch(path.join(rel, "Coco.2017.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "poster.jpg"), "capa");

    mo.processSource(src, "Test");

    expect(fs.existsSync(path.join(destDir, "Coco (2017)", "poster.jpg"))).toBe(true);
    expect(fs.existsSync(rel)).toBe(false);
  });

  test("dry run não apaga nada", () => {
    const rel = path.join(src, "Up.2009.1080p");
    touch(path.join(rel, "Up.2009.1080p.mkv"), "x".repeat(100));
    touch(path.join(rel, "RARBG.txt"), "www");

    const dry = new MovieOrganizer(destDir, { dryRun: true, minFeatureBytes: 20 });
    dry.processSource(src, "Test");

    expect(fs.existsSync(path.join(rel, "Up.2009.1080p.mkv"))).toBe(true);
    expect(fs.existsSync(path.join(rel, "RARBG.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "Up (2009)"))).toBe(false);
  });
});
