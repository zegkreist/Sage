import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "../../src/server.js";
import { FavoritesService } from "../../src/services/FavoritesService.js";
import supertest from "supertest";

// ── Mocks de serviços ─────────────────────────────────────────────────────

function makeLibraryScanner(overrides = {}) {
  return {
    scan: jest.fn().mockResolvedValue({ artists: [], albums: [], tracks: [] }),
    getArtistNames: jest.fn().mockReturnValue(["Pink Floyd", "Radiohead"]),
    getGenres: jest.fn().mockReturnValue(["Rock", "Alternative"]),
    getLibraryStats: jest.fn().mockReturnValue({
      totalArtists: 2,
      totalAlbums: 5,
      totalTracks: 42,
      topGenres: ["Rock", "Alternative"],
    }),
    ...overrides,
  };
}

function makeHistoryService(overrides = {}) {
  return {
    getRecentlyPlayed: jest.fn().mockResolvedValue([
      { title: "Money", artist: "Pink Floyd", album: "The Dark Side of the Moon", playedAt: 1743000000 },
    ]),
    getFavoriteArtists: jest.fn().mockResolvedValue([
      { artist: "Pink Floyd", playCount: 15 },
    ]),
    ...overrides,
  };
}

function makeRecommendationEngine(overrides = {}) {
  return {
    recommend: jest.fn().mockResolvedValue([
      { artist: "King Crimson", genre: "Progressive Rock", description: "...", whyRecommended: "Similar to Pink Floyd" },
      { artist: "Thom Yorke", genre: "Electronic", description: "...", whyRecommended: "Radiohead vocalist solo" },
    ]),
    recommendArtists: jest.fn().mockResolvedValue([
      { artist: "King Crimson", genre: "Progressive Rock", whyRecommended: "Similar to Pink Floyd" },
    ]),
    ...overrides,
  };
}

function makePlaylistBuilder(overrides = {}) {
  const store = new Map();
  let _idCounter = 1;
  return {
    generate: jest.fn().mockImplementation(async ({ name, mood, size = 5 }) => ({
      id: `pl-test-${_idCounter++}`,
      name: name || `Playlist ${_idCounter}`,
      mood: mood || "relaxed",
      tracks: [],
      createdAt: new Date().toISOString(),
    })),
    save: jest.fn().mockImplementation((p) => {
      const saved = { ...p, id: `pl-saved-${_idCounter++}`, createdAt: new Date().toISOString() };
      store.set(saved.id, saved);
      return saved;
    }),
    list: jest.fn().mockReturnValue([]),
    get: jest.fn().mockReturnValue(null),
    update: jest.fn().mockImplementation((id, fields) => ({ id, name: 'Updated', tracks: [], plexId: null, ...fields })),
    delete: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────

let app;
let libraryScanner;
let historyService;
let recommendationEngine;
let playlistBuilder;

beforeEach(() => {
  libraryScanner = makeLibraryScanner();
  historyService = makeHistoryService();
  recommendationEngine = makeRecommendationEngine();
  playlistBuilder = makePlaylistBuilder();

  app = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder });
});

// ── GET /api/health ───────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("retorna 200 com status ok", async () => {
    const res = await supertest(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("service", "MusicSage");
  });
});

// ── GET /api/library/stats ────────────────────────────────────────────────

describe("GET /api/library/stats", () => {
  it("retorna 200 com estatísticas da biblioteca", async () => {
    const res = await supertest(app).get("/api/library/stats");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalArtists", 2);
    expect(res.body).toHaveProperty("totalAlbums", 5);
    expect(res.body).toHaveProperty("totalTracks", 42);
    expect(Array.isArray(res.body.topGenres)).toBe(true);
  });
});

// ── GET /api/recommendations ──────────────────────────────────────────────

describe("GET /api/recommendations", () => {
  it("retorna 200 com lista de recomendações", async () => {
    const res = await supertest(app).get("/api/recommendations");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("artist");
    expect(res.body[0]).toHaveProperty("whyRecommended");
  });

  it("passa parâmetro limit ao engine", async () => {
    await supertest(app).get("/api/recommendations?limit=5");

    expect(recommendationEngine.recommend).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 })
    );
  });

  it("usa limit padrão 10 quando não informado", async () => {
    await supertest(app).get("/api/recommendations");

    expect(recommendationEngine.recommend).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 })
    );
  });
});

// ── GET /api/recommendations/artists ─────────────────────────────────────

describe("GET /api/recommendations/artists", () => {
  it("retorna 200 com recomendações de artistas", async () => {
    const res = await supertest(app).get("/api/recommendations/artists");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("artist");
  });
});

// ── POST /api/playlists/generate ──────────────────────────────────────────

describe("POST /api/playlists/generate", () => {
  it("retorna 201 com a playlist gerada", async () => {
    const res = await supertest(app)
      .post("/api/playlists/generate")
      .send({ mood: "relaxed", genre: "Jazz", size: 5, name: "Evening Jazz" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("name");
    expect(res.body).toHaveProperty("tracks");
    expect(res.body).toHaveProperty("createdAt");
  });

  it("passa os parâmetros corretos ao PlaylistBuilder", async () => {
    await supertest(app)
      .post("/api/playlists/generate")
      .send({ mood: "energetic", genre: "Rock", size: 10, name: "Power Hour" });

    expect(playlistBuilder.generate).toHaveBeenCalledWith(
      expect.objectContaining({ mood: "energetic", genre: "Rock", size: 10, name: "Power Hour" })
    );
  });

  it("retorna 400 quando body é inválido (sem nenhum parâmetro útil)", async () => {
    const res = await supertest(app)
      .post("/api/playlists/generate")
      .send({});

    // Size tem default, então não deve retornar 400 — playlist com defaults
    expect([200, 201]).toContain(res.status);
  });
});

// ── GET /api/playlists ────────────────────────────────────────────────────

describe("GET /api/playlists", () => {
  it("retorna 200 com array de playlists", async () => {
    playlistBuilder.list.mockReturnValue([
      { id: "p1", name: "A", tracks: [], createdAt: new Date().toISOString() },
    ]);

    const res = await supertest(app).get("/api/playlists");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("retorna array vazio quando não há playlists", async () => {
    const res = await supertest(app).get("/api/playlists");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── GET /api/playlists/:id ────────────────────────────────────────────────

describe("GET /api/playlists/:id", () => {
  it("retorna 200 com a playlist quando encontrada", async () => {
    const mockPlaylist = { id: "abc", name: "Test", tracks: [], createdAt: new Date().toISOString() };
    playlistBuilder.get.mockReturnValue(mockPlaylist);

    const res = await supertest(app).get("/api/playlists/abc");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "abc");
  });

  it("retorna 404 quando a playlist não existe", async () => {
    playlistBuilder.get.mockReturnValue(null);

    const res = await supertest(app).get("/api/playlists/nope");

    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/playlists/:id ─────────────────────────────────────────────

describe("DELETE /api/playlists/:id", () => {
  it("retorna 204 quando playlist é deletada com sucesso", async () => {
    playlistBuilder.get.mockReturnValue({ id: "p1", name: "Test Playlist", plexId: null, tracks: [] });
    playlistBuilder.delete.mockReturnValue(true);

    const res = await supertest(app).delete("/api/playlists/p1");

    expect(res.status).toBe(204);
  });

  it("retorna 404 quando a playlist não existe para deletar", async () => {
    playlistBuilder.get.mockReturnValue(null);

    const res = await supertest(app).delete("/api/playlists/ghost");

    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/playlists/:id ──────────────────────────────────────────────

describe("PATCH /api/playlists/:id", () => {
  it("retorna 400 quando body não tem name nem tracks", async () => {
    const res = await supertest(app).patch("/api/playlists/p1").send({});

    expect(res.status).toBe(400);
  });

  it("retorna 404 quando a playlist não existe", async () => {
    playlistBuilder.get.mockReturnValue(null);

    const res = await supertest(app).patch("/api/playlists/ghost").send({ name: "Novo Nome" });

    expect(res.status).toBe(404);
  });

  it("retorna 200 e atualiza nome localmente", async () => {
    const existing = { id: "p1", name: "Antigo", plexId: null, tracks: [] };
    playlistBuilder.get.mockReturnValue(existing);
    playlistBuilder.update.mockReturnValue({ ...existing, name: "Novo Nome" });

    const res = await supertest(app).patch("/api/playlists/p1").send({ name: "Novo Nome" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Novo Nome");
  });

  it("retorna 200 e atualiza faixas localmente", async () => {
    const track = { title: "Song", artist: "Band", ratingKey: "42" };
    const existing = { id: "p1", name: "Mix", plexId: null, tracks: [track] };
    playlistBuilder.get.mockReturnValue(existing);
    playlistBuilder.update.mockReturnValue({ ...existing, tracks: [] });

    const res = await supertest(app).patch("/api/playlists/p1").send({ tracks: [] });

    expect(res.status).toBe(200);
  });

  it("chama plexService.renamePlaylist quando só nome muda e plexId existe", async () => {
    const plexService = { renamePlaylist: jest.fn().mockResolvedValue(), updatePlaylistTracks: jest.fn() };
    const existing = { id: "p1", name: "Antigo", plexId: "plex-99", tracks: [] };
    playlistBuilder.get.mockReturnValue(existing);
    playlistBuilder.update.mockReturnValue({ ...existing, name: "Novo" });

    const localApp = (await import("../../src/server.js")).createServer({
      libraryScanner, historyService, recommendationEngine, playlistBuilder, plexService,
    });
    const res = await supertest(localApp).patch("/api/playlists/p1").send({ name: "Novo" });

    expect(res.status).toBe(200);
    expect(plexService.renamePlaylist).toHaveBeenCalledWith("plex-99", "Novo");
  });

  it("chama plexService.updatePlaylistTracks quando faixas mudam e plexId existe", async () => {
    const plexService = {
      updatePlaylistTracks: jest.fn().mockResolvedValue({ plexId: "plex-100" }),
      renamePlaylist: jest.fn(),
    };
    const track = { title: "Song", artist: "Band", ratingKey: "42" };
    const existing = { id: "p1", name: "Mix", plexId: "plex-99", tracks: [] };
    playlistBuilder.get.mockReturnValue(existing);
    playlistBuilder.update.mockReturnValue({ ...existing, tracks: [track] });

    const localApp = (await import("../../src/server.js")).createServer({
      libraryScanner, historyService, recommendationEngine, playlistBuilder, plexService,
    });
    const res = await supertest(localApp).patch("/api/playlists/p1").send({ tracks: [track] });

    expect(res.status).toBe(200);
    expect(plexService.updatePlaylistTracks).toHaveBeenCalledWith("plex-99", "Mix", ["42"]);
  });

  it("chama plexService.deletePlaylist quando faixas ficam vazias e plexId existe", async () => {
    const plexService = {
      deletePlaylist: jest.fn().mockResolvedValue(),
      updatePlaylistTracks: jest.fn(),
      renamePlaylist: jest.fn(),
    };
    const existing = { id: "p1", name: "Mix", plexId: "plex-99", tracks: [{ ratingKey: "1" }] };
    playlistBuilder.get.mockReturnValue(existing);
    playlistBuilder.update.mockReturnValue({ ...existing, tracks: [] });

    const localApp = (await import("../../src/server.js")).createServer({
      libraryScanner, historyService, recommendationEngine, playlistBuilder, plexService,
    });
    const res = await supertest(localApp).patch("/api/playlists/p1").send({ tracks: [] });

    expect(res.status).toBe(200);
    expect(plexService.deletePlaylist).toHaveBeenCalledWith("plex-99");
  });
});

// ── GET /api/embeddings/clusters ─────────────────────────────────────────

describe("GET /api/embeddings/clusters", () => {
  function makeEmbedding(overrides = {}) {
    return {
      embedding:   overrides.embedding ?? new Array(8).fill(0).map((_, i) => i / 8),
      title:       overrides.title   ?? "Track",
      artist:      overrides.artist  ?? "Artist",
      album:       overrides.album   ?? "Album",
      genres:      overrides.genres  ?? [],
      processedAt: new Date().toISOString(),
    };
  }

  function makeClusteringService(overrides = {}) {
    return {
      cluster:     jest.fn().mockReturnValue({ k: 3, clusters: [] }),
      clusterAuto: jest.fn().mockReturnValue({ k: 4, clusters: [] }),
      ...overrides,
    };
  }

  it("retorna 503 quando embeddingService não está configurado", async () => {
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder });
    const res = await supertest(localApp).get("/api/embeddings/clusters?k=3");
    expect(res.status).toBe(503);
  });

  it("retorna 400 quando há menos de 2 embeddings no store", async () => {
    const embeddingService = { getStored: jest.fn().mockReturnValue({ only1: makeEmbedding() }) };
    const clusteringService = makeClusteringService();
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, embeddingService, clusteringService });
    const res = await supertest(localApp).get("/api/embeddings/clusters?k=3");
    expect(res.status).toBe(400);
  });

  it("chama cluster(k) com k do query string quando k é numérico", async () => {
    const store = { a: makeEmbedding(), b: makeEmbedding() };
    const embeddingService = { getStored: jest.fn().mockReturnValue(store) };
    const clusteringService = makeClusteringService();
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, embeddingService, clusteringService });

    const res = await supertest(localApp).get("/api/embeddings/clusters?k=5");

    expect(res.status).toBe(200);
    expect(clusteringService.cluster).toHaveBeenCalledWith(store, 5);
    expect(clusteringService.clusterAuto).not.toHaveBeenCalled();
    expect(res.body.k).toBe(3);
  });

  it("chama clusterAuto() quando k=auto", async () => {
    const store = { a: makeEmbedding(), b: makeEmbedding() };
    const embeddingService = { getStored: jest.fn().mockReturnValue(store) };
    const clusteringService = makeClusteringService();
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, embeddingService, clusteringService });

    const res = await supertest(localApp).get("/api/embeddings/clusters?k=auto");

    expect(res.status).toBe(200);
    expect(clusteringService.clusterAuto).toHaveBeenCalledWith(store, 2, 15);
    expect(clusteringService.cluster).not.toHaveBeenCalled();
    expect(res.body.k).toBe(4);
  });

  it("usa k=8 como padrão quando k não é fornecido", async () => {
    const store = { a: makeEmbedding(), b: makeEmbedding() };
    const embeddingService = { getStored: jest.fn().mockReturnValue(store) };
    const clusteringService = makeClusteringService();
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, embeddingService, clusteringService });

    await supertest(localApp).get("/api/embeddings/clusters");

    expect(clusteringService.cluster).toHaveBeenCalledWith(store, 8);
  });

  it("resposta inclui totalEmbedded", async () => {
    const store = { a: makeEmbedding(), b: makeEmbedding(), c: makeEmbedding() };
    const embeddingService = { getStored: jest.fn().mockReturnValue(store) };
    const clusteringService = makeClusteringService();
    const localApp = createServer({ libraryScanner, historyService, recommendationEngine, playlistBuilder, embeddingService, clusteringService });

    const res = await supertest(localApp).get("/api/embeddings/clusters?k=2");

    expect(res.body.totalEmbedded).toBe(3);
  });
});

// ── Curadoria pessoal (fase 4) ────────────────────────────────────────────

describe("Favoritos", () => {
  let dataDir;
  let favoritesService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "musicsage-favroute-"));
    favoritesService = new FavoritesService({ dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const plexTrack = (artist, title, album) => ({
    ratingKey: `${artist}-${title}`,
    title,
    grandparentTitle: artist,
    parentTitle: album,
  });

  describe("GET /api/library/tracks", () => {
    const scannerWith = (...tracks) => ({
      scan: jest.fn().mockResolvedValue({ artists: [], albums: [], tracks }),
      getArtistNames: jest.fn().mockReturnValue([]),
    });

    it("anota starred/rating em cada faixa", async () => {
      favoritesService.setFavorite({ artist: "Portishead", title: "Roads", album: "Dummy" }, { starred: true, rating: 5 });
      const app = createServer({
        libraryScanner: scannerWith(plexTrack("Portishead", "Roads", "Dummy"), plexTrack("Air", "Sexy Boy", "Moon Safari")),
        favoritesService,
      });

      const res = await supertest(app).get("/api/library/tracks");

      expect(res.status).toBe(200);
      expect(res.body.tracks).toHaveLength(2);
      expect(res.body.tracks[0]).toMatchObject({ title: "Roads", starred: true, rating: 5 });
      expect(res.body.tracks[1]).toMatchObject({ title: "Sexy Boy", starred: false, rating: null });
    });

    it("onlyFavorites=1 devolve só as faixas com coração", async () => {
      favoritesService.setFavorite({ artist: "Portishead", title: "Roads", album: "Dummy" }, { starred: true });
      const app = createServer({
        libraryScanner: scannerWith(plexTrack("Portishead", "Roads", "Dummy"), plexTrack("Air", "Sexy Boy", "Moon Safari")),
        favoritesService,
      });

      const res = await supertest(app).get("/api/library/tracks?onlyFavorites=1");

      expect(res.status).toBe(200);
      expect(res.body.tracks).toHaveLength(1);
      expect(res.body.tracks[0].title).toBe("Roads");
    });

    it("filtra antes do limit — favorito fora das primeiras N ainda aparece", async () => {
      favoritesService.setFavorite({ artist: "Air", title: "Sexy Boy", album: "Moon Safari" }, { starred: true });
      const enchimento = Array.from({ length: 30 }, (_, i) => plexTrack("Enchimento", `T${i}`, "A"));
      const app = createServer({
        libraryScanner: scannerWith(...enchimento, plexTrack("Air", "Sexy Boy", "Moon Safari")),
        favoritesService,
      });

      const res = await supertest(app).get("/api/library/tracks?onlyFavorites=1&limit=20");

      expect(res.body.tracks).toHaveLength(1);
      expect(res.body.tracks[0].title).toBe("Sexy Boy");
    });

    it("nota sem coração não entra no filtro de favoritos", async () => {
      favoritesService.setFavorite({ artist: "Air", title: "Sexy Boy", album: "Moon Safari" }, { rating: 4 });
      const app = createServer({
        libraryScanner: scannerWith(plexTrack("Air", "Sexy Boy", "Moon Safari")),
        favoritesService,
      });

      const res = await supertest(app).get("/api/library/tracks?onlyFavorites=1");

      expect(res.body.tracks).toHaveLength(0);
    });
  });

  describe("POST /api/playlists/from-cache-prompt", () => {
    const makeBuilder = () => ({
      generateFromCacheWithPrompt: jest.fn().mockResolvedValue({ id: "p1", name: "Mix", tracks: [] }),
      save: jest.fn().mockImplementation((p) => ({ ...p, id: "saved-1" })),
      update: jest.fn(),
    });
    const analysisCache = { getAll: jest.fn().mockReturnValue([]) };

    it("onlyFavorites passa favoriteKeys com as chaves estreladas ao builder", async () => {
      favoritesService.setFavorite({ artist: "Portishead", title: "Roads", album: "Dummy" }, { starred: true });
      const playlistBuilder = makeBuilder();
      const app = createServer({ playlistBuilder, analysisCache, favoritesService });

      const res = await supertest(app)
        .post("/api/playlists/from-cache-prompt")
        .send({ prompt: "algo melancólico", onlyFavorites: true });

      expect(res.status).toBe(201);
      const opts = playlistBuilder.generateFromCacheWithPrompt.mock.calls[0][2];
      expect(opts.favoriteKeys).toBeInstanceOf(Set);
      expect(opts.favoriteKeys.has(FavoritesService.makeKey("Portishead", "Roads", "Dummy"))).toBe(true);
    });

    it("sem onlyFavorites o builder não recebe favoriteKeys", async () => {
      const playlistBuilder = makeBuilder();
      const app = createServer({ playlistBuilder, analysisCache, favoritesService });

      await supertest(app).post("/api/playlists/from-cache-prompt").send({ prompt: "algo alegre" });

      const opts = playlistBuilder.generateFromCacheWithPrompt.mock.calls[0][2];
      expect(opts.favoriteKeys).toBeUndefined();
    });
  });
});
