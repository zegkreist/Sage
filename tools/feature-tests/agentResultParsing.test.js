/**
 * FEATURE: parsing de resultados dos agentes.
 *  - Stormbringer: DownloadManager.saveState()/stateFile e sanitizeFilename
 *  - TideCaller:   linhas JSON do tidal_query.py e o parser do startTidalJob
 *                  (replicado de musicsage/src/routes/tools.js, que não é
 *                  exportável isoladamente)
 */
import fs from "fs";
import path from "path";
import { beforeEach, afterEach, describe, expect, test } from "@jest/globals";
import { makeTmp, touch, rmRf } from "./helpers.js";

let tmp;
beforeEach(() => {
  tmp = makeTmp("agent-parse-");
});
afterEach(() => rmRf(tmp));

// ─── Stormbringer ─────────────────────────────────────────────────────────────

describe("Stormbringer DownloadManager — parsing", () => {
  // Import dinâmico: webtorrent é pesado; construímos o manager offline.
  let DownloadManager;
  beforeAll(async () => {
    ({ default: DownloadManager } = await import("../../agents/Stormbringer/src/downloadManager.js"));
  });

  function makeDM(extra = {}) {
    return new DownloadManager({
      downloads: {
        baseDir: tmp,
        movies: path.join(tmp, "filmes"),
        series: path.join(tmp, "series"),
        music: path.join(tmp, "musicas"),
        stateFile: path.join(tmp, "state.json"),
      },
      metadata: { enabled: false },
      ...extra,
    });
  }

  test("sanitizeFilename remove caracteres invasivos", () => {
    const dm = makeDM();
    expect(dm.sanitizeFilename('AC/DC: Back?*')).toBe("AC_DC_ Back__");
  });

  test("sanitizeFilename NÃO neutraliza path traversal (..)", () => {
    const dm = makeDM();
    const clean = dm.sanitizeFilename("../../etc");
    const resolved = path.resolve(tmp, clean);
    // BUG: ".." sobrevive à sanitização => pasta pode escapar da biblioteca
    expect(resolved.startsWith(tmp)).toBe(true); // FALHA = bug confirmado
  });

  test("organizeMusicFiles move faixas para musicas/Artista/Album", async () => {
    const dm = makeDM();
    const torrentDir = path.join(tmp, "torrentdl");
    touch(path.join(torrentDir, "01 - a.flac"));
    touch(path.join(torrentDir, "02 - b.flac"));
    const torrent = {
      path: torrentDir,
      files: [{ path: "01 - a.flac" }, { path: "02 - b.flac" }],
    };
    dm.organizeMusicFiles(torrent, { artist: "Test Artist", album: "Test Album" });
    expect(fs.existsSync(path.join(tmp, "musicas", "Test Artist", "Test Album", "01 - a.flac"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "musicas", "Test Artist", "Test Album", "02 - b.flac"))).toBe(true);
  });

  test("organizeMusicFiles: artista com '/' não vira aninhamento", async () => {
    const dm = makeDM();
    const torrentDir = path.join(tmp, "dl2");
    touch(path.join(torrentDir, "x.flac"));
    dm.organizeMusicFiles({ path: torrentDir, files: [{ path: "x.flac" }] }, { artist: "AC/DC", album: "Bon" });
    // sanitizeFilename troca '/' por '_' — não pode ter criado dest/AC/DC
    expect(fs.existsSync(path.join(tmp, "musicas", "AC"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "musicas", "AC_DC", "Bon", "x.flac"))).toBe(true);
  });

  test("saveState grava stateFile legível pelo /api/tools/stormbringer/downloads", async () => {
    const dm = makeDM();
    dm.activeTorrents.set("abc123", {
      infoHash: "abc123", name: "Album [FLAC]", type: "music", status: "downloading",
      progress: 50, downloaded: 1, total: 2, downloadSpeed: 10, uploadSpeed: 0,
      peers: 3, startTime: Date.now(),
    });
    dm.saveState();
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"));
    expect(raw.torrents).toHaveLength(1);
    expect(raw.torrents[0].infoHash).toBe("abc123");
    expect(typeof raw.lastUpdate).toBe("number");
    await dm.destroy();
  });
});

// ─── TideCaller ───────────────────────────────────────────────────────────────

/**
 * Replicação do parser do startTidalJob (musicsage/src/routes/tools.js ~L443):
 * consume stdout linha a linha, buffer parcial, ignora não-JSON e a linha
 * {done:true} final.
 */
function makeTidalJobParser(job) {
  let buf = "";
  return function onData(chunk) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        const itemId = parsed.albumId; // kind=album
        if (itemId) {
          const entry = job.albums.find((a) => a.id === itemId);
          if (entry) {
            entry.status = parsed.ok ? "done" : "error";
            if (parsed.error) entry.lastError = parsed.error;
            if (parsed.tracksExpected != null) {
              entry.tracksExpected = parsed.tracksExpected;
              entry.tracksDownloaded = parsed.tracksDownloaded;
              entry.complete = parsed.complete;
            }
          }
        }
        // linha {done:true} é ignorada de propósito
      } catch { /* non-JSON — ignore */ }
    }
  };
}

describe("TideCaller — parsing das linhas JSON do tidal_query.py", () => {
  test("status por álbum: ok/error mapeados corretamente", () => {
    const job = { albums: [{ id: "1", name: "A", status: "pending" }, { id: "2", name: "B", status: "pending" }] };
    const onData = makeTidalJobParser(job);
    onData(Buffer.from('{"albumId":"1","ok":true,"tracksExpected":10,"tracksDownloaded":10,"complete":true}\n'));
    // linha dividida no meio de um chunk (fluxo real de stdout): a 1ª metade
    // fica em buffer e só é parseada quando a 2ª metade chega
    onData(Buffer.from('{"albumId":"2","ok":fal'));
    onData(Buffer.from('se,"error":"token expirado"}\n'));
    expect(job.albums[0].status).toBe("done");
    expect(job.albums[0].tracksDownloaded).toBe(10);
    expect(job.albums[1].status).toBe("error");
    expect(job.albums[1].lastError).toBe("token expirado");
  });

  test("linha final {done:true} NÃO muda status de itens", () => {
    const job = { albums: [{ id: "9", name: "X", status: "error" }] };
    const onData = makeTidalJobParser(job);
    onData(Buffer.from('{"done":true,"results":[]}\n'));
    expect(job.albums[0].status).toBe("error");
  });

  test("cálculo do status final do job (lógica do handler 'close')", () => {
    const finalize = (albums) => {
      albums.forEach((a) => { if (a.status === "pending") a.status = "error"; });
      const done = albums.filter((a) => a.status === "done").length;
      const error = albums.filter((a) => a.status === "error").length;
      return error === 0 && done > 0 ? "done" : "error";
    };
    expect(finalize([{ status: "done" }, { status: "done" }])).toBe("done");
    expect(finalize([{ status: "done" }, { status: "error" }])).toBe("error");
    // álbum que nunca recebeu JSON (pending) deve virar erro, não sucesso
    expect(finalize([{ status: "pending" }])).toBe("error");
  });

  test("_find_album_folder (replicado do Python): substring match pode colidir", () => {
    const dl = path.join(tmp, "tc");
    fs.mkdirSync(path.join(dl, "Abbey Road (1969) [FLAC] [16B-44.1kHz]"), { recursive: true });
    fs.mkdirSync(path.join(dl, "Abbey Road Super Deluxe (1969) [FLAC]"), { recursive: true });
    // mesma heurística do tidal_query.py: primeiro diretório cujo nome contém o título
    const findAlbumFolder = (base, name) =>
      fs.readdirSync(base).find((d) => d.toLowerCase().includes(name.toLowerCase())) || null;
    const found = findAlbumFolder(dl, "Abbey Road");
    // Não é determinístico qual pasta é "a" — se o álbum errado for escolhido,
    // a contagem de faixas fica errada e o album é marcado incompleto.
    expect(found).not.toBeNull();
  });
});
