/**
 * Organização pós-download — testes offline (sem rede, sem torrent real).
 *
 * O teste antigo em downloadManager.test.js ("Deve criar estrutura de pastas
 * para música") criava as pastas com fs.mkdirSync e só verificava que elas
 * existiam — nunca chamava organizeMusicFiles(). Por isso não pegou o bug em
 * que torrent.files[].path (RELATIVO a torrent.path no webtorrent ≥ 2) era
 * usado direto em fs.existsSync: o existsSync dava false, nenhum arquivo era
 * movido, e a pasta Artista/Álbum ficava vazia sem nenhum erro.
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import DownloadManager from "../src/downloadManager.js";

/** Torrent falso com a mesma forma que o webtorrent entrega: path relativo. */
function fakeTorrent(downloadDir, torrentName, fileNames) {
  const files = fileNames.map((name) => ({
    name,
    path: path.join(torrentName, name), // relativo — é assim que o webtorrent expõe
    length: 1024,
  }));
  for (const f of files) {
    const abs = path.join(downloadDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "audio");
  }
  return { name: torrentName, path: downloadDir, files };
}

describe("DownloadManager — organização offline", () => {
  let tmpDir;
  let dm;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-organize-"));
    dm = new DownloadManager({
      downloads: {
        baseDir: tmpDir,
        movies: path.join(tmpDir, "filmes"),
        series: path.join(tmpDir, "series"),
        music: path.join(tmpDir, "musicas"),
        stateFile: path.join(tmpDir, "state.json"),
      },
      metadata: { enabled: false },
    });
    dm.setLogger(() => {});
  });

  afterEach(async () => {
    await dm.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("absoluteFilePath()", () => {
    test("resolve o path relativo do arquivo contra o diretório do torrent", () => {
      const abs = dm.absoluteFilePath(
        { path: "/downloads/musicas" },
        { path: "Album Folder/01 - Faixa.flac" },
      );
      expect(abs).toBe("/downloads/musicas/Album Folder/01 - Faixa.flac");
    });
  });

  describe("organizeMusicFiles()", () => {
    test("move as faixas da pasta do torrent para Artista/Álbum", () => {
      const musicDir = path.join(tmpDir, "musicas");
      const torrent = fakeTorrent(musicDir, "Some.Release.2019.FLAC", [
        "01 - Primeira.flac",
        "02 - Segunda.flac",
      ]);

      dm.organizeMusicFiles(torrent, { artist: "Test Artist", album: "Test Album" });

      const albumDir = path.join(musicDir, "Test Artist", "Test Album");
      expect(fs.readdirSync(albumDir).sort()).toEqual([
        "01 - Primeira.flac",
        "02 - Segunda.flac",
      ]);
      // E nada ficou para trás na pasta original do torrent
      expect(fs.readdirSync(path.join(musicDir, "Some.Release.2019.FLAC"))).toEqual([]);
    });

    test("sanitiza artista e álbum ao montar as pastas", () => {
      const musicDir = path.join(tmpDir, "musicas");
      const torrent = fakeTorrent(musicDir, "Release", ["faixa.flac"]);

      dm.organizeMusicFiles(torrent, { artist: 'AC/DC: Live', album: 'Album "X"' });

      const albumDir = path.join(musicDir, "AC_DC_ Live", "Album _X_");
      expect(fs.existsSync(path.join(albumDir, "faixa.flac"))).toBe(true);
    });

    test("sem álbum, as faixas vão direto para a pasta do artista", () => {
      const musicDir = path.join(tmpDir, "musicas");
      const torrent = fakeTorrent(musicDir, "Release", ["faixa.flac"]);

      dm.organizeMusicFiles(torrent, { artist: "Só Artista" });

      expect(fs.existsSync(path.join(musicDir, "Só Artista", "faixa.flac"))).toBe(true);
    });
  });
});
