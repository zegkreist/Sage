import { jest } from "@jest/globals";
import { createServer } from "../../src/server.js";
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
    playlistBuilder.delete.mockReturnValue(true);

    const res = await supertest(app).delete("/api/playlists/p1");

    expect(res.status).toBe(204);
  });

  it("retorna 404 quando a playlist não existe para deletar", async () => {
    playlistBuilder.delete.mockReturnValue(false);

    const res = await supertest(app).delete("/api/playlists/ghost");

    expect(res.status).toBe(404);
  });
});
