import { jest } from "@jest/globals";
import { MusicAnalyzer } from "../../src/services/MusicAnalyzer.js";

function makeAllFather(overrides = {}) {
  return {
    askForJSON: jest.fn(),
    ask: jest.fn(),
    ...overrides,
  };
}

const ARTIST_ANALYSIS_RESPONSE = {
  genre: "Progressive Rock",
  mood: "introspective",
  energy: 6,
  timbre: "rich, layered, atmospheric",
  tempo: "mid-tempo",
  characteristics: ["concept albums", "long compositions", "psychedelic elements"],
};

const LIBRARY_PROFILE_RESPONSE = {
  topGenres: ["Progressive Rock", "Alternative Rock", "Jazz"],
  dominantMood: "introspective",
  avgEnergy: 5.5,
  characteristics: ["complex arrangements", "lyrical depth"],
};

describe("MusicAnalyzer", () => {
  let allfather;
  let analyzer;

  beforeEach(() => {
    allfather = makeAllFather();
    analyzer = new MusicAnalyzer({ allfather });
  });

  // ── analyzeArtist() ───────────────────────────────────────────────────────

  describe("analyzeArtist()", () => {
    it("chama AllFather.askForJSON com nome do artista e retorna análise estruturada", async () => {
      allfather.askForJSON.mockResolvedValueOnce(ARTIST_ANALYSIS_RESPONSE);

      const result = await analyzer.analyzeArtist("Pink Floyd", ["Rock"], ["Money", "Wish You Were Here"]);

      expect(allfather.askForJSON).toHaveBeenCalledTimes(1);
      const promptArg = allfather.askForJSON.mock.calls[0][0];
      expect(promptArg).toContain("Pink Floyd");
    });

    it("retorna campos genre, mood, energy, timbre e characteristics", async () => {
      allfather.askForJSON.mockResolvedValueOnce(ARTIST_ANALYSIS_RESPONSE);

      const result = await analyzer.analyzeArtist("Pink Floyd", ["Rock"], []);

      expect(result).toHaveProperty("genre");
      expect(result).toHaveProperty("mood");
      expect(result).toHaveProperty("energy");
      expect(result).toHaveProperty("timbre");
      expect(result).toHaveProperty("characteristics");
      expect(Array.isArray(result.characteristics)).toBe(true);
    });

    it("retorna análise padrão (graceful) quando AllFather falha", async () => {
      allfather.askForJSON.mockRejectedValueOnce(new Error("Ollama timeout"));

      const result = await analyzer.analyzeArtist("Pink Floyd", ["Rock"], []);

      // Não lança, retorna fallback estruturado
      expect(result).toHaveProperty("genre");
      expect(result).toHaveProperty("mood");
      expect(result.characteristics).toEqual([]);
    });

    it("inclui gêneros do Plex no prompt para contexto extra", async () => {
      allfather.askForJSON.mockResolvedValueOnce(ARTIST_ANALYSIS_RESPONSE);

      await analyzer.analyzeArtist("Miles Davis", ["Jazz", "Bebop"], ["So What", "Kind of Blue"]);

      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("Jazz");
    });
  });

  // ── buildLibraryProfile() ────────────────────────────────────────────────

  describe("buildLibraryProfile()", () => {
    it("chama AllFather com lista de artistas e retorna perfil da biblioteca", async () => {
      allfather.askForJSON.mockResolvedValueOnce(LIBRARY_PROFILE_RESPONSE);

      const artists = [
        { name: "Pink Floyd", genres: ["Rock"] },
        { name: "Radiohead", genres: ["Alternative"] },
        { name: "Miles Davis", genres: ["Jazz"] },
      ];

      const result = await analyzer.buildLibraryProfile(artists);

      expect(allfather.askForJSON).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty("topGenres");
      expect(Array.isArray(result.topGenres)).toBe(true);
      expect(result).toHaveProperty("dominantMood");
      expect(result).toHaveProperty("avgEnergy");
    });

    it("retorna perfil vazio quando lista de artistas é vazia", async () => {
      const result = await analyzer.buildLibraryProfile([]);

      expect(allfather.askForJSON).not.toHaveBeenCalled();
      expect(result.topGenres).toEqual([]);
    });

    it("retorna perfil fallback quando AllFather falha", async () => {
      allfather.askForJSON.mockRejectedValueOnce(new Error("model not loaded"));

      const result = await analyzer.buildLibraryProfile([{ name: "Pink Floyd", genres: ["Rock"] }]);

      expect(result).toHaveProperty("topGenres");
      expect(result).toHaveProperty("dominantMood");
    });
  });

  // ── analyzeListeningTaste() ───────────────────────────────────────────────

  describe("analyzeListeningTaste()", () => {
    it("retorna preferências baseadas no histórico de reprodução", async () => {
      allfather.askForJSON.mockResolvedValueOnce({
        preferredGenres: ["Progressive Rock", "Jazz"],
        patterns: ["ouve mais tarde da noite", "prefere álbuns completos"],
      });

      const history = [
        { artist: "Pink Floyd", title: "Money", playedAt: 1742900000 },
        { artist: "Miles Davis", title: "So What", playedAt: 1742800000 },
      ];

      const result = await analyzer.analyzeListeningTaste(history);

      expect(result).toHaveProperty("preferredGenres");
      expect(result).toHaveProperty("patterns");
    });

    it("retorna objeto vazio graceful quando histórico é vazio", async () => {
      const result = await analyzer.analyzeListeningTaste([]);

      expect(allfather.askForJSON).not.toHaveBeenCalled();
      expect(result.preferredGenres).toEqual([]);
      expect(result.patterns).toEqual([]);
    });
  });
});
