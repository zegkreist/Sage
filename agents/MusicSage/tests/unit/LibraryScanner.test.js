import { jest } from "@jest/globals";
import { LibraryScanner } from "../../src/services/LibraryScanner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAxios(overrides = {}) {
  return {
    get: jest.fn(),
    post: jest.fn(),
    ...overrides,
  };
}

const PLEX_SECTIONS_RESPONSE = {
  data: {
    MediaContainer: {
      Directory: [
        { key: "1", type: "movie", title: "Filmes" },
        { key: "2", type: "artist", title: "Música" },
      ],
    },
  },
};

const PLEX_ARTISTS_RESPONSE = {
  data: {
    MediaContainer: {
      Metadata: [
        { ratingKey: "10", title: "Pink Floyd", genre: [{ tag: "Rock" }], thumb: "/thumb/10" },
        { ratingKey: "11", title: "Radiohead", genre: [{ tag: "Alternative" }, { tag: "Rock" }] },
        { ratingKey: "12", title: "Miles Davis", genre: [{ tag: "Jazz" }] },
      ],
    },
  },
};

const PLEX_ALBUMS_RESPONSE = {
  data: {
    MediaContainer: {
      Metadata: [
        { ratingKey: "20", title: "The Dark Side of the Moon", parentTitle: "Pink Floyd", year: 1973 },
        { ratingKey: "21", title: "OK Computer", parentTitle: "Radiohead", year: 1997 },
      ],
    },
  },
};

const PLEX_TRACKS_RESPONSE = {
  data: {
    MediaContainer: {
      Metadata: [
        {
          ratingKey: "30",
          title: "Money",
          grandparentTitle: "Pink Floyd",
          parentTitle: "The Dark Side of the Moon",
          duration: 382000,
        },
        {
          ratingKey: "31",
          title: "Karma Police",
          grandparentTitle: "Radiohead",
          parentTitle: "OK Computer",
          duration: 264000,
        },
      ],
    },
  },
};

// ── Testes ────────────────────────────────────────────────────────────────

describe("LibraryScanner", () => {
  let axios;
  let scanner;

  beforeEach(() => {
    axios = makeAxios();
    scanner = new LibraryScanner({
      axios,
      plexUrl: "http://localhost:32400",
      plexToken: "test-token",
    });
  });

  // ── scan() ───────────────────────────────────────────────────────────────

  describe("scan()", () => {
    it("encontra a seção de música e retorna artistas, álbuns e faixas", async () => {
      axios.get
        .mockResolvedValueOnce(PLEX_SECTIONS_RESPONSE) // /library/sections
        .mockResolvedValueOnce(PLEX_ARTISTS_RESPONSE)  // artistas
        .mockResolvedValueOnce(PLEX_ALBUMS_RESPONSE)   // álbuns
        .mockResolvedValueOnce(PLEX_TRACKS_RESPONSE);  // faixas

      const result = await scanner.scan();

      expect(result).toHaveProperty("artists");
      expect(result).toHaveProperty("albums");
      expect(result).toHaveProperty("tracks");
      expect(result.artists).toHaveLength(3);
      expect(result.albums).toHaveLength(2);
      expect(result.tracks).toHaveLength(2);
    });

    it("retorna arrays vazios quando não há seção musical no Plex", async () => {
      axios.get.mockResolvedValueOnce({
        data: { MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Filmes" }] } },
      });

      const result = await scanner.scan();

      expect(result.artists).toEqual([]);
      expect(result.albums).toEqual([]);
      expect(result.tracks).toEqual([]);
    });

    it("retorna arrays vazios e não lança erro quando o Plex está indisponível", async () => {
      axios.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await scanner.scan();

      expect(result.artists).toEqual([]);
      expect(result.albums).toEqual([]);
      expect(result.tracks).toEqual([]);
    });
  });

  // ── getArtistNames() ─────────────────────────────────────────────────────

  describe("getArtistNames()", () => {
    it("retorna lista de nomes de artistas após scan", async () => {
      axios.get
        .mockResolvedValueOnce(PLEX_SECTIONS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ARTISTS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ALBUMS_RESPONSE)
        .mockResolvedValueOnce(PLEX_TRACKS_RESPONSE);

      await scanner.scan();
      const names = scanner.getArtistNames();

      expect(names).toContain("Pink Floyd");
      expect(names).toContain("Radiohead");
      expect(names).toContain("Miles Davis");
    });

    it("retorna array vazio se scan ainda não foi chamado", () => {
      const names = scanner.getArtistNames();
      expect(names).toEqual([]);
    });
  });

  // ── getGenres() ──────────────────────────────────────────────────────────

  describe("getGenres()", () => {
    it("retorna gêneros únicos existentes na biblioteca", async () => {
      axios.get
        .mockResolvedValueOnce(PLEX_SECTIONS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ARTISTS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ALBUMS_RESPONSE)
        .mockResolvedValueOnce(PLEX_TRACKS_RESPONSE);

      await scanner.scan();
      const genres = scanner.getGenres();

      expect(genres).toContain("Rock");
      expect(genres).toContain("Alternative");
      expect(genres).toContain("Jazz");
      // deduplicado — Rock aparece em 2 artistas mas conta só uma vez
      expect(genres.filter((g) => g === "Rock")).toHaveLength(1);
    });
  });

  // ── getLibraryStats() ────────────────────────────────────────────────────

  describe("getLibraryStats()", () => {
    it("retorna contagens totais e top gêneros após scan", async () => {
      axios.get
        .mockResolvedValueOnce(PLEX_SECTIONS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ARTISTS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ALBUMS_RESPONSE)
        .mockResolvedValueOnce(PLEX_TRACKS_RESPONSE);

      await scanner.scan();
      const stats = scanner.getLibraryStats();

      expect(stats.totalArtists).toBe(3);
      expect(stats.totalAlbums).toBe(2);
      expect(stats.totalTracks).toBe(2);
      expect(Array.isArray(stats.topGenres)).toBe(true);
      expect(stats.topGenres.length).toBeGreaterThan(0);
    });

    it("retorna zeros quando scan não foi executado", () => {
      const stats = scanner.getLibraryStats();

      expect(stats.totalArtists).toBe(0);
      expect(stats.totalAlbums).toBe(0);
      expect(stats.totalTracks).toBe(0);
    });
  });

  // ── Headers Plex ─────────────────────────────────────────────────────────

  describe("autenticação Plex", () => {
    it("inclui X-Plex-Token e Accept: application/json em todas as chamadas", async () => {
      axios.get
        .mockResolvedValueOnce(PLEX_SECTIONS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ARTISTS_RESPONSE)
        .mockResolvedValueOnce(PLEX_ALBUMS_RESPONSE)
        .mockResolvedValueOnce(PLEX_TRACKS_RESPONSE);

      await scanner.scan();

      const firstCall = axios.get.mock.calls[0];
      expect(firstCall[1].headers["X-Plex-Token"]).toBe("test-token");
      expect(firstCall[1].headers["Accept"]).toBe("application/json");
    });
  });
});
