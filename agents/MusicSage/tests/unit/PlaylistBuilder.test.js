import { jest } from "@jest/globals";
import { PlaylistBuilder } from "../../src/services/PlaylistBuilder.js";

function makeAllFather(overrides = {}) {
  return { askForJSON: jest.fn(), ask: jest.fn(), ...overrides };
}

function makeLibraryScanner(tracks = []) {
  return {
    scan: jest.fn().mockResolvedValue({ artists: [], albums: [], tracks }),
    getArtistNames: jest.fn().mockReturnValue([]),
  };
}

const SAMPLE_TRACKS = [
  { ratingKey: "30", title: "Money", grandparentTitle: "Pink Floyd", parentTitle: "The Dark Side of the Moon", duration: 382000 },
  { ratingKey: "31", title: "Karma Police", grandparentTitle: "Radiohead", parentTitle: "OK Computer", duration: 264000 },
  { ratingKey: "32", title: "Comfortably Numb", grandparentTitle: "Pink Floyd", parentTitle: "The Wall", duration: 382000 },
  { ratingKey: "33", title: "Creep", grandparentTitle: "Radiohead", parentTitle: "Pablo Honey", duration: 239000 },
  { ratingKey: "34", title: "So What", grandparentTitle: "Miles Davis", parentTitle: "Kind of Blue", duration: 562000 },
];

const OLLAMA_PLAYLIST_RESPONSE = [
  { ratingKey: "31", title: "Karma Police", artist: "Radiohead" },
  { ratingKey: "32", title: "Comfortably Numb", artist: "Pink Floyd" },
  { ratingKey: "34", title: "So What", artist: "Miles Davis" },
];

describe("PlaylistBuilder", () => {
  let allfather;
  let libraryScanner;
  let builder;

  beforeEach(() => {
    allfather = makeAllFather();
    libraryScanner = makeLibraryScanner(SAMPLE_TRACKS);
    builder = new PlaylistBuilder({ allfather, libraryScanner, storageFile: false });
    allfather.askForJSON.mockResolvedValue(OLLAMA_PLAYLIST_RESPONSE);
  });

  // ── generate() ────────────────────────────────────────────────────────────

  describe("generate()", () => {
    it("retorna playlist com id, name, tracks e createdAt", async () => {
      const playlist = await builder.generate({ name: "Evening Chill", mood: "relaxed", size: 3 });

      expect(playlist).toHaveProperty("id");
      expect(playlist).toHaveProperty("name", "Evening Chill");
      expect(playlist).toHaveProperty("tracks");
      expect(playlist).toHaveProperty("createdAt");
      expect(Array.isArray(playlist.tracks)).toBe(true);
    });

    it("usa AllFather para selecionar faixas da biblioteca", async () => {
      await builder.generate({ mood: "relaxed", size: 3 });

      expect(allfather.askForJSON).toHaveBeenCalledTimes(1);
      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("relaxed");
    });

    it("respeita o parâmetro size na seleção de faixas", async () => {
      const playlist = await builder.generate({ size: 2 });

      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("2");
    });

    it("inclui gênero no prompt quando informado", async () => {
      await builder.generate({ genre: "Jazz", size: 5 });

      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("Jazz");
    });

    it("gera nome automático quando name não é fornecido", async () => {
      const playlist = await builder.generate({ mood: "energetic" });

      expect(typeof playlist.name).toBe("string");
      expect(playlist.name.length).toBeGreaterThan(0);
    });

    it("retorna playlist com faixas vazias graceful quando AllFather falha", async () => {
      allfather.askForJSON.mockRejectedValueOnce(new Error("Ollama down"));

      const playlist = await builder.generate({ mood: "happy" });

      expect(playlist).toHaveProperty("id");
      expect(playlist.tracks).toEqual([]);
    });
  });

  // ── save() ────────────────────────────────────────────────────────────────

  describe("save()", () => {
    it("salva playlist e retorna com id e createdAt preenchidos", () => {
      const playlist = { name: "Test Playlist", tracks: [] };

      const saved = builder.save(playlist);

      expect(saved).toHaveProperty("id");
      expect(saved).toHaveProperty("createdAt");
      expect(saved.name).toBe("Test Playlist");
    });

    it("playlists salvas ficam disponíveis via list()", () => {
      builder.save({ name: "P1", tracks: [] });
      builder.save({ name: "P2", tracks: [] });

      const all = builder.list();
      expect(all).toHaveLength(2);
    });
  });

  // ── list() ────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("retorna array vazio quando não há playlists salvas", () => {
      expect(builder.list()).toEqual([]);
    });

    it("retorna todas as playlists salvas", () => {
      builder.save({ name: "A", tracks: [] });
      builder.save({ name: "B", tracks: [] });
      builder.save({ name: "C", tracks: [] });

      expect(builder.list()).toHaveLength(3);
    });
  });

  // ── get() ─────────────────────────────────────────────────────────────────

  describe("get()", () => {
    it("retorna playlist pelo id", () => {
      const saved = builder.save({ name: "My Playlist", tracks: [] });

      const found = builder.get(saved.id);

      expect(found).not.toBeNull();
      expect(found.name).toBe("My Playlist");
    });

    it("retorna null para id desconhecido", () => {
      const found = builder.get("non-existent-id");

      expect(found).toBeNull();
    });
  });

  // ── delete() ─────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("remove playlist pelo id e retorna true", () => {
      const saved = builder.save({ name: "To Delete", tracks: [] });

      const result = builder.delete(saved.id);

      expect(result).toBe(true);
      expect(builder.get(saved.id)).toBeNull();
    });

    it("retorna false para id desconhecido", () => {
      const result = builder.delete("ghost-id");

      expect(result).toBe(false);
    });

    it("lista diminui após delete", () => {
      const p1 = builder.save({ name: "K", tracks: [] });
      builder.save({ name: "L", tracks: [] });

      builder.delete(p1.id);

      expect(builder.list()).toHaveLength(1);
    });
  });
});
