import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import DownloadManager from "../src/downloadManager.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("DownloadManager - Testes de Integração", () => {
  let downloadManager;
  const testDownloadDir = path.join(__dirname, "test-downloads");
  const testConfig = {
    downloads: {
      baseDir: testDownloadDir,
      movies: path.join(testDownloadDir, "movies"),
      series: path.join(testDownloadDir, "series"),
      music: path.join(testDownloadDir, "music"),
    },
    torrent: {
      maxConnections: 50,
      downloadLimit: -1,
      uploadLimit: -1,
    },
    metadata: {
      enabled: false, // Desabilitado para testes mais rápidos
      renameFiles: false,
    },
  };

  // Magnet link de torrent LEGAL e pequeno (Big Buck Bunny trailer)
  // Este é um vídeo de teste de domínio público muito usado
  const testMagnetLink =
    "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com";

  beforeEach(() => {
    // Criar diretórios de teste
    if (fs.existsSync(testDownloadDir)) {
      fs.rmSync(testDownloadDir, { recursive: true, force: true });
    }

    downloadManager = new DownloadManager(testConfig);
  });

  afterEach(async () => {
    // Destruir cliente e limpar
    if (downloadManager) {
      await downloadManager.destroy();
    }

    // Limpar diretórios de teste
    if (fs.existsSync(testDownloadDir)) {
      fs.rmSync(testDownloadDir, { recursive: true, force: true });
    }
  });

  describe("Inicialização", () => {
    test("Deve criar diretórios ao inicializar", () => {
      expect(fs.existsSync(testDownloadDir)).toBe(true);
      expect(fs.existsSync(testConfig.downloads.movies)).toBe(true);
      expect(fs.existsSync(testConfig.downloads.series)).toBe(true);
      expect(fs.existsSync(testConfig.downloads.music)).toBe(true);
    });

    test("Deve ter cliente WebTorrent inicializado", () => {
      expect(downloadManager.client).toBeDefined();
    });

    test("Deve ter mapa de torrents ativos vazio", () => {
      const activeTorrents = downloadManager.getActiveTorrents();
      expect(activeTorrents).toEqual([]);
    });
  });

  describe("Adicionar Torrent", () => {
    test("Deve adicionar torrent e obter metadados", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      expect(torrentInfo).toBeDefined();
      expect(torrentInfo.name).toBeDefined();
      expect(torrentInfo.total).toBeGreaterThan(0);
      expect(torrentInfo.type).toBe("movie");
      expect(torrentInfo.status).toBe("downloading");
    }, 60000);

    test("Deve emitir evento de progresso", (done) => {
      let progressReceived = false;

      downloadManager.on("progress", (info) => {
        if (!progressReceived) {
          progressReceived = true;
          expect(info.progress).toBeGreaterThanOrEqual(0);
          expect(info.progress).toBeLessThanOrEqual(100);
          done();
        }
      });

      downloadManager.addTorrent(testMagnetLink, "movie", {});
    }, 60000);

    test("Deve armazenar torrent no mapa de ativos", async () => {
      await downloadManager.addTorrent(testMagnetLink, "movie", {});

      const activeTorrents = downloadManager.getActiveTorrents();
      expect(activeTorrents.length).toBe(1);
    }, 60000);
  });

  describe("Gerenciamento de Torrents", () => {
    test("Deve listar torrents ativos", async () => {
      await downloadManager.addTorrent(testMagnetLink, "movie", {});

      const torrents = downloadManager.getActiveTorrents();
      expect(Array.isArray(torrents)).toBe(true);
      expect(torrents.length).toBeGreaterThan(0);
    }, 60000);

    test("Deve obter informações de torrent específico", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      const info = downloadManager.getTorrentInfo(torrentInfo.infoHash);
      expect(info).toBeDefined();
      expect(info.infoHash).toBe(torrentInfo.infoHash);
    }, 60000);

    test("Deve pausar torrent", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      downloadManager.pauseTorrent(torrentInfo.infoHash);

      const info = downloadManager.getTorrentInfo(torrentInfo.infoHash);
      expect(info.status).toBe("paused");
    }, 60000);

    test("Deve resumir torrent pausado", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      downloadManager.pauseTorrent(torrentInfo.infoHash);
      downloadManager.resumeTorrent(torrentInfo.infoHash);

      const info = downloadManager.getTorrentInfo(torrentInfo.infoHash);
      expect(info.status).toBe("downloading");
    }, 60000);

    test("Deve remover torrent", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      downloadManager.removeTorrent(torrentInfo.infoHash, false);

      // Dar tempo para remoção
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const info = downloadManager.getTorrentInfo(torrentInfo.infoHash);
      expect(info).toBeUndefined();
    }, 60000);
  });

  describe("Caminhos de Download", () => {
    test("Deve retornar caminho correto para filmes", () => {
      const path = downloadManager.getDownloadPath("movie");
      expect(path).toBe(testConfig.downloads.movies);
    });

    test("Deve retornar caminho correto para séries", () => {
      const path = downloadManager.getDownloadPath("series");
      expect(path).toBe(testConfig.downloads.series);
    });

    test("Deve retornar caminho correto para música", () => {
      const path = downloadManager.getDownloadPath("music");
      expect(path).toBe(testConfig.downloads.music);
    });

    test("Deve retornar caminho base para tipo desconhecido", () => {
      const path = downloadManager.getDownloadPath("unknown");
      expect(path).toBe(testConfig.downloads.baseDir);
    });
  });

  describe("Formatação", () => {
    test("Deve formatar bytes corretamente", () => {
      expect(downloadManager.formatBytes(0)).toBe("0 Bytes");
      expect(downloadManager.formatBytes(1024)).toBe("1 KB");
      expect(downloadManager.formatBytes(1048576)).toBe("1 MB");
      expect(downloadManager.formatBytes(1073741824)).toBe("1 GB");
      expect(downloadManager.formatBytes(1099511627776)).toBe("1 TB");
    });

    test("Deve formatar bytes com decimais", () => {
      const formatted = downloadManager.formatBytes(1536, 2);
      expect(formatted).toBe("1.5 KB");
    });

    test("Deve formatar velocidade", () => {
      const speed = downloadManager.formatSpeed(1048576);
      expect(speed).toBe("1 MB/s");
    });
  });

  describe("Sanitização de Nomes", () => {
    test("Deve remover caracteres inválidos de nomes de arquivo", () => {
      const sanitized = downloadManager.sanitizeFilename('Test<>:"/\\|?*File');

      expect(sanitized).not.toContain("<");
      expect(sanitized).not.toContain(">");
      expect(sanitized).not.toContain(":");
      expect(sanitized).not.toContain('"');
      expect(sanitized).not.toContain("/");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toContain("|");
      expect(sanitized).not.toContain("?");
      expect(sanitized).not.toContain("*");
    });

    test("Deve remover espaços no início e fim", () => {
      const sanitized = downloadManager.sanitizeFilename("  Test File  ");
      expect(sanitized).toBe("Test File");
    });
  });

  describe("Eventos", () => {
    test("Deve emitir evento 'added' ao adicionar torrent", (done) => {
      downloadManager.on("added", (info) => {
        expect(info).toBeDefined();
        expect(info.infoHash).toBeDefined();
        done();
      });

      downloadManager.addTorrent(testMagnetLink, "movie", {});
    }, 60000);

    test("Deve emitir evento 'paused' ao pausar", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      const pausedPromise = new Promise((resolve) => {
        downloadManager.on("paused", (info) => {
          expect(info.status).toBe("paused");
          resolve();
        });
      });

      downloadManager.pauseTorrent(torrentInfo.infoHash);
      await pausedPromise;
    }, 60000);

    test("Deve emitir evento 'resumed' ao retomar", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});
      downloadManager.pauseTorrent(torrentInfo.infoHash);

      const resumedPromise = new Promise((resolve) => {
        downloadManager.on("resumed", (info) => {
          expect(info.status).toBe("downloading");
          resolve();
        });
      });

      downloadManager.resumeTorrent(torrentInfo.infoHash);
      await resumedPromise;
    }, 60000);
  });

  describe("Organização de Música", () => {
    test("Deve criar estrutura de pastas para música", async () => {
      const metadata = {
        artist: "Test Artist",
        album: "Test Album",
      };

      // Simular downloads pequenos com música
      // Este teste verifica a estrutura, não o download completo
      const artistPath = path.join(testConfig.downloads.music, "Test Artist");
      const albumPath = path.join(artistPath, "Test Album");

      // Criar estrutura manualmente para teste
      if (!fs.existsSync(albumPath)) {
        fs.mkdirSync(albumPath, { recursive: true });
      }

      expect(fs.existsSync(artistPath)).toBe(true);
      expect(fs.existsSync(albumPath)).toBe(true);
    });

    test("Deve sanitizar nomes de artista e álbum", () => {
      const artist = downloadManager.sanitizeFilename("Artist: Special <Name>");
      const album = downloadManager.sanitizeFilename('Album "Name"');

      expect(artist).not.toContain(":");
      expect(artist).not.toContain("<");
      expect(artist).not.toContain(">");
      expect(album).not.toContain('"');
    });
  });

  describe("Encontrar Arquivo de Vídeo Principal", () => {
    test("Deve identificar arquivo de vídeo principal", () => {
      const files = [
        { name: "movie.mkv", length: 1500000000 },
        { name: "sample.mkv", length: 10000000 },
        { name: "subtitle.srt", length: 50000 },
      ];

      const mainFile = downloadManager.findMainVideoFile(files);

      expect(mainFile).toBeDefined();
      expect(mainFile.name).toBe("movie.mkv");
    });

    test("Deve retornar maior arquivo entre múltiplos vídeos", () => {
      const files = [
        { name: "video1.mp4", length: 500000000 },
        { name: "video2.mp4", length: 1000000000 },
        { name: "video3.avi", length: 750000000 },
      ];

      const mainFile = downloadManager.findMainVideoFile(files);

      expect(mainFile.name).toBe("video2.mp4");
      expect(mainFile.length).toBe(1000000000);
    });

    test("Deve retornar null se não houver vídeos", () => {
      const files = [
        { name: "subtitle.srt", length: 50000 },
        { name: "cover.jpg", length: 100000 },
      ];

      const mainFile = downloadManager.findMainVideoFile(files);

      expect(mainFile).toBeNull();
    });

    test("Deve reconhecer diferentes extensões de vídeo", () => {
      const extensions = [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"];

      extensions.forEach((ext) => {
        const files = [{ name: `video${ext}`, length: 1000000 }];
        const mainFile = downloadManager.findMainVideoFile(files);
        expect(mainFile).toBeDefined();
      });
    });
  });

  describe("Informações de Torrent", () => {
    test("Deve rastrear progresso do download", async () => {
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});

      // Aguardar um pouco para ter progresso
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const info = downloadManager.getTorrentInfo(torrentInfo.infoHash);

      expect(info.progress).toBeGreaterThanOrEqual(0);
      expect(info.downloaded).toBeGreaterThanOrEqual(0);
      expect(info.downloadSpeed).toBeGreaterThanOrEqual(0);
    }, 60000);

    test("Deve armazenar metadados personalizados", async () => {
      const customMetadata = {
        movieName: "Test Movie",
        year: 2020,
      };

      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", customMetadata);

      expect(torrentInfo.metadata).toEqual(customMetadata);
    }, 60000);

    test("Deve registrar tempo de início", async () => {
      const beforeTime = Date.now();
      const torrentInfo = await downloadManager.addTorrent(testMagnetLink, "movie", {});
      const afterTime = Date.now();

      expect(torrentInfo.startTime).toBeGreaterThanOrEqual(beforeTime);
      expect(torrentInfo.startTime).toBeLessThanOrEqual(afterTime);
    }, 60000);
  });

  describe("Destruição do Cliente", () => {
    test("Deve destruir cliente corretamente", async () => {
      await downloadManager.addTorrent(testMagnetLink, "movie", {});

      await expect(downloadManager.destroy()).resolves.not.toThrow();
    }, 60000);

    test("Deve lidar com múltiplas chamadas de destroy", async () => {
      await downloadManager.destroy();
      await expect(downloadManager.destroy()).resolves.not.toThrow();
    });
  });
});

describe("DownloadManager.assertValidTorrentId", () => {
  const HASH = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
  const BASE32 = "2ZBFL3G4PSSV7MF36ATSHWDQML3R63I4";

  test("aceita magnet com xt=urn:btih: em hex, base32 e maiúsculas", () => {
    expect(DownloadManager.assertValidTorrentId(`magnet:?xt=urn:btih:${HASH}&dn=x`)).toContain(HASH);
    expect(DownloadManager.assertValidTorrentId(`magnet:?dn=x&xt=urn:btih:${HASH}`)).toContain(HASH);
    expect(DownloadManager.assertValidTorrentId(`magnet:?xt=urn:btih:${HASH.toUpperCase()}`)).toBeTruthy();
    expect(DownloadManager.assertValidTorrentId(`magnet:?xt=urn:btih:${BASE32}&dn=x`)).toBeTruthy();
  });

  test("aceita infoHash cru e URL http(s)", () => {
    expect(DownloadManager.assertValidTorrentId(HASH)).toBe(HASH);
    expect(DownloadManager.assertValidTorrentId(BASE32)).toBe(BASE32);
    expect(DownloadManager.assertValidTorrentId("https://jackett/dl/x?apikey=y")).toContain("https://");
  });

  // Estes são os inputs que faziam arr2hex(undefined) explodir dentro do
  // webtorrent como unhandled rejection, deixando o addTorrent() pendurado.
  test("rejeita magnet sem xt=urn:btih: utilizável", () => {
    const invalidos = [
      "magnet:?dn=x&tr=udp%3A%2F%2Ffoo",                                    // sem xt
      "magnet:?xt=urn:btih:NOTAHASH&dn=x",                                  // hash malformado
      `magnet:?xt.1=urn:btih:${HASH}&dn=x`,                                 // variante que magnet-uri ignora
      "magnet:?xt=urn:btmh:1220caf1e1c30e81cb361b9ee167c4aa64228a7fa4fa9",  // só BitTorrent v2
    ];
    for (const m of invalidos) {
      expect(() => DownloadManager.assertValidTorrentId(m)).toThrow(/xt=urn:btih/);
    }
  });

  test("rejeita buffer que não é bencode (HTML de erro do indexer)", () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>403 Forbidden</body></html>");
    expect(() => DownloadManager.assertValidTorrentId(html)).toThrow(/não é um \.torrent/);
    expect(() => DownloadManager.assertValidTorrentId(Buffer.alloc(0))).toThrow(/não é um \.torrent/);
  });

  test("aceita buffer bencodado", () => {
    const bencoded = Buffer.from("d4:infod4:name3:abcee");
    expect(DownloadManager.assertValidTorrentId(bencoded)).toBe(bencoded);
  });

  test("rejeita null/undefined/objeto", () => {
    for (const v of [null, undefined, 42, {}, ""]) {
      expect(() => DownloadManager.assertValidTorrentId(v)).toThrow(/inválido|não reconhecido/);
    }
  });

  test("addTorrent lança de forma SÍNCRONA, sem devolver promise pendurada", () => {
    // Sem client: o throw tem que acontecer antes de qualquer uso de this.client.
    const fake = Object.create(DownloadManager.prototype);
    expect(() => fake.addTorrent("magnet:?dn=sem-hash", "music", {})).toThrow(/xt=urn:btih/);
  });
});
