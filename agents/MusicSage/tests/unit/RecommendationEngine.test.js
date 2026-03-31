import { jest } from "@jest/globals";
import { RecommendationEngine } from "../../src/services/RecommendationEngine.js";

function makeAllFather(overrides = {}) {
  return { askForJSON: jest.fn(), ask: jest.fn(), ...overrides };
}

function makeLibraryScanner(artists = ["Pink Floyd", "Radiohead", "Miles Davis"]) {
  return {
    getArtistNames: jest.fn().mockReturnValue(artists),
    getArtistsWithGenres: jest.fn().mockReturnValue(
      artists.map((name) => ({ name, genres: ["Rock"] }))
    ),
    getGenres: jest.fn().mockReturnValue(["Rock", "Alternative", "Jazz"]),
    getLibraryStats: jest.fn().mockReturnValue({ totalArtists: 3, totalAlbums: 10, totalTracks: 120 }),
  };
}

function makeHistoryService(history = []) {
  return {
    getRecentlyPlayed: jest.fn().mockResolvedValue(history),
    getFavoriteArtists: jest.fn().mockResolvedValue([
      { artist: "Pink Floyd", playCount: 15 },
      { artist: "Radiohead", playCount: 10 },
    ]),
  };
}

function makeAnalyzer(profile = {}) {
  return {
    buildLibraryProfile: jest.fn().mockResolvedValue({
      topGenres: ["Progressive Rock", "Alternative"],
      dominantMood: "introspective",
      avgEnergy: 5.5,
      ...profile,
    }),
    analyzeListeningTaste: jest.fn().mockResolvedValue({
      preferredGenres: ["Rock", "Jazz"],
      patterns: [],
    }),
  };
}

const OLLAMA_RECOMMENDATIONS = [
  {
    artist: "King Crimson",
    genre: "Progressive Rock",
    description: "Banda seminal do rock progressivo britânico",
    whyRecommended: "Similaridade com Pink Floyd em complexidade e atmosfera",
  },
  {
    artist: "Thom Yorke",
    genre: "Alternative Electronic",
    description: "Projeto solo do vocalista do Radiohead",
    whyRecommended: "Mesmo universo sonoro do Radiohead com influências eletrônicas",
  },
  {
    artist: "John Coltrane",
    genre: "Jazz",
    description: "Saxofonista lendário do jazz modal",
    whyRecommended: "Colegas de era com Miles Davis, sonoridade complementar",
  },
];

describe("RecommendationEngine", () => {
  let allfather;
  let libraryScanner;
  let historyService;
  let analyzer;
  let engine;

  beforeEach(() => {
    allfather = makeAllFather();
    libraryScanner = makeLibraryScanner();
    historyService = makeHistoryService();
    analyzer = makeAnalyzer();

    engine = new RecommendationEngine({ allfather, libraryScanner, historyService, analyzer });
    allfather.askForJSON.mockResolvedValue(OLLAMA_RECOMMENDATIONS);
  });

  // ── recommend() ───────────────────────────────────────────────────────────

  describe("recommend()", () => {
    it("retorna lista de recomendações com campos obrigatórios", async () => {
      const recs = await engine.recommend({ limit: 3 });

      expect(Array.isArray(recs)).toBe(true);
      expect(recs.length).toBeGreaterThan(0);
      recs.forEach((r) => {
        expect(r).toHaveProperty("artist");
        expect(r).toHaveProperty("genre");
        expect(r).toHaveProperty("whyRecommended");
      });
    });

    it("não inclui artistas que já estão na biblioteca", async () => {
      // Ollama retorna artistas que incluem "Pink Floyd" (já na biblioteca)
      allfather.askForJSON.mockResolvedValueOnce([
        ...OLLAMA_RECOMMENDATIONS,
        {
          artist: "Pink Floyd",
          genre: "Progressive Rock",
          description: "Já existe",
          whyRecommended: "Já existe",
        },
      ]);

      const recs = await engine.recommend({ limit: 10 });

      const artistNames = recs.map((r) => r.artist);
      expect(artistNames).not.toContain("Pink Floyd");
      expect(artistNames).not.toContain("Radiohead");
      expect(artistNames).not.toContain("Miles Davis");
    });

    it("respeita o parâmetro limit", async () => {
      const recs = await engine.recommend({ limit: 2 });

      expect(recs.length).toBeLessThanOrEqual(2);
    });

    it("usa limit padrão de 10 quando não informado", async () => {
      const recs = await engine.recommend();

      // Verifica que o prompt pede um número de recomendações
      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("10");
    });

    it("consulta perfil da biblioteca antes de perguntar ao Ollama", async () => {
      await engine.recommend();

      expect(analyzer.buildLibraryProfile).toHaveBeenCalled();
    });

    it("inclui histórico de favoritos no prompt para contexto", async () => {
      await engine.recommend();

      expect(historyService.getFavoriteArtists).toHaveBeenCalled();
      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toMatch(/Pink Floyd|Radiohead/);
    });

    it("retorna array vazio graceful quando AllFather falha", async () => {
      allfather.askForJSON.mockRejectedValueOnce(new Error("Ollama unavailable"));

      const recs = await engine.recommend();

      expect(recs).toEqual([]);
    });
  });

  // ── recommendArtists() ───────────────────────────────────────────────────

  describe("recommendArtists()", () => {
    it("retorna somente recomendações de artistas (mesmo formato)", async () => {
      const recs = await engine.recommendArtists({ limit: 5 });

      expect(Array.isArray(recs)).toBe(true);
      recs.forEach((r) => {
        expect(r).toHaveProperty("artist");
        expect(r).toHaveProperty("whyRecommended");
      });
    });

    it("não inclui artistas já na biblioteca", async () => {
      allfather.askForJSON.mockResolvedValueOnce([
        ...OLLAMA_RECOMMENDATIONS,
        { artist: "Radiohead", genre: "Alternative", description: "x", whyRecommended: "y" },
      ]);

      const recs = await engine.recommendArtists({ limit: 10 });

      expect(recs.map((r) => r.artist)).not.toContain("Radiohead");
    });
  });
});
