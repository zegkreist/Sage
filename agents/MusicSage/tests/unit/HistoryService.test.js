import { jest } from "@jest/globals";
import { HistoryService } from "../../src/services/HistoryService.js";

function makeAxios(overrides = {}) {
  return { get: jest.fn(), post: jest.fn(), ...overrides };
}

const PLEX_HISTORY_RESPONSE = {
  data: {
    MediaContainer: {
      Metadata: [
        {
          title: "Money",
          grandparentTitle: "Pink Floyd",
          parentTitle: "The Dark Side of the Moon",
          viewedAt: 1743000000,
          type: "track",
        },
        {
          title: "Karma Police",
          grandparentTitle: "Radiohead",
          parentTitle: "OK Computer",
          viewedAt: 1742900000,
          type: "track",
        },
        {
          title: "Brain Damage",
          grandparentTitle: "Pink Floyd",
          parentTitle: "The Dark Side of the Moon",
          viewedAt: 1742800000,
          type: "track",
        },
        {
          title: "High and Dry",
          grandparentTitle: "Radiohead",
          parentTitle: "The Bends",
          viewedAt: 1742700000,
          type: "track",
        },
        {
          title: "So What",
          grandparentTitle: "Miles Davis",
          parentTitle: "Kind of Blue",
          viewedAt: 1742600000,
          type: "track",
        },
      ],
    },
  },
};

describe("HistoryService", () => {
  let axios;
  let service;

  beforeEach(() => {
    axios = makeAxios();
    service = new HistoryService({
      axios,
      plexUrl: "http://localhost:32400",
      plexToken: "test-token",
    });
  });

  // ── getRecentlyPlayed() ───────────────────────────────────────────────────

  describe("getRecentlyPlayed()", () => {
    it("retorna lista de faixas ouvidas recentemente com campos corretos", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      const tracks = await service.getRecentlyPlayed();

      expect(tracks).toHaveLength(5);
      expect(tracks[0]).toMatchObject({
        title: "Money",
        artist: "Pink Floyd",
        album: "The Dark Side of the Moon",
      });
      expect(tracks[0]).toHaveProperty("playedAt");
    });

    it("respeita o parâmetro limit", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      await service.getRecentlyPlayed(3);

      const callArgs = axios.get.mock.calls[0];
      expect(callArgs[1].params.limit).toBe(3);
    });

    it("usa limit padrão de 50 quando não informado", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      await service.getRecentlyPlayed();

      const callArgs = axios.get.mock.calls[0];
      expect(callArgs[1].params.limit).toBe(50);
    });

    it("retorna array vazio quando Plex não responde", async () => {
      axios.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const tracks = await service.getRecentlyPlayed();

      expect(tracks).toEqual([]);
    });

    it("retorna array vazio quando não há histórico", async () => {
      axios.get.mockResolvedValueOnce({
        data: { MediaContainer: {} },
      });

      const tracks = await service.getRecentlyPlayed();

      expect(tracks).toEqual([]);
    });
  });

  // ── getFavoriteArtists() ──────────────────────────────────────────────────

  describe("getFavoriteArtists()", () => {
    it("retorna artistas ordenados por número de plays", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      const artists = await service.getFavoriteArtists();

      // Pink Floyd = 2 plays, Radiohead = 2 plays, Miles Davis = 1 play
      expect(artists[0].artist).toMatch(/Pink Floyd|Radiohead/);
      expect(artists[artists.length - 1].artist).toBe("Miles Davis");
    });

    it("cada entrada contém artist e playCount", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      const artists = await service.getFavoriteArtists();

      expect(artists[0]).toHaveProperty("artist");
      expect(artists[0]).toHaveProperty("playCount");
    });

    it("respeita o parâmetro limit", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      const artists = await service.getFavoriteArtists(2);

      expect(artists).toHaveLength(2);
    });

    it("retorna array vazio quando Plex está indisponível", async () => {
      axios.get.mockRejectedValueOnce(new Error("timeout"));

      const artists = await service.getFavoriteArtists();

      expect(artists).toEqual([]);
    });
  });

  // ── Autenticação ──────────────────────────────────────────────────────────

  describe("autenticação Plex", () => {
    it("usa o endpoint correto do histórico de sessões", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      await service.getRecentlyPlayed();

      const url = axios.get.mock.calls[0][0];
      expect(url).toContain("/status/sessions/history/all");
    });

    it("inclui X-Plex-Token no header", async () => {
      axios.get.mockResolvedValueOnce(PLEX_HISTORY_RESPONSE);

      await service.getRecentlyPlayed();

      const headers = axios.get.mock.calls[0][1].headers;
      expect(headers["X-Plex-Token"]).toBe("test-token");
    });
  });
});
