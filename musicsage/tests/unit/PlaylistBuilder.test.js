import { jest } from "@jest/globals";
import { PlaylistBuilder } from "../../src/services/PlaylistBuilder.js";
import { FavoritesService } from "../../src/services/FavoritesService.js";

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

const OLLAMA_PLAYLIST_RESPONSE = [31, 32, 34];

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

  // ── generateFromPrompt() ──────────────────────────────────────────────────

  describe("generateFromPrompt()", () => {
    function makeEmbeddingService(results = []) {
      return { searchByText: jest.fn().mockResolvedValue(results) };
    }

    it("retorna playlist com prompt preservado no resultado", async () => {
      builder = new PlaylistBuilder({ allfather, libraryScanner, storageFile: false });
      // LLM call 1: extrai params; LLM call 2: seleciona faixas
      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "relaxed", genre: null, energy: 3, size: 3 })
        .mockResolvedValueOnce(OLLAMA_PLAYLIST_RESPONSE);

      const result = await builder.generateFromPrompt("late night jazz session");
      expect(result.prompt).toBe("late night jazz session");
    });

    it("usa candidatos semânticos quando embeddingService retorna resultados", async () => {
      // Apenas 2 faixas aparecem no resultado semântico
      const semanticHits = [
        { ratingKey: "31", similarity: 0.95 },
        { ratingKey: "34", similarity: 0.88 },
      ];
      const embSvc = makeEmbeddingService(semanticHits);
      builder = new PlaylistBuilder({ allfather, libraryScanner, embeddingService: embSvc, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "relaxed", genre: null, energy: null, size: 2 })
        .mockResolvedValueOnce([31, 34]);

      await builder.generateFromPrompt("mellow jazz for studying");

      // O prompt de seleção deve conter apenas faixas do resultado semântico
      const selectionCall = allfather.askForJSON.mock.calls[1];
      const selectionPrompt = selectionCall[0];
      expect(selectionPrompt).toContain("Karma Police"); // ratingKey 31
      expect(selectionPrompt).toContain("So What");      // ratingKey 34
      // Faixas não retornadas pelo embedding não devem aparecer
      expect(selectionPrompt).not.toContain("Money");    // ratingKey 30 — não está nos hits
    });

    it("inclui o prompt original como critério temático para o LLM", async () => {
      const embSvc = makeEmbeddingService([{ ratingKey: "31", similarity: 0.9 }]);
      builder = new PlaylistBuilder({ allfather, libraryScanner, embeddingService: embSvc, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: null, genre: null, energy: null, size: 1 })
        .mockResolvedValueOnce([31]);

      await builder.generateFromPrompt("music for a rainy Sunday afternoon");

      const selectionPrompt = allfather.askForJSON.mock.calls[1][0];
      expect(selectionPrompt).toContain("rainy Sunday afternoon");
    });

    it("faz fallback para metadata pre-filter quando embeddingService não está configurado", async () => {
      // builder sem embeddingService
      builder = new PlaylistBuilder({ allfather, libraryScanner, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "energetic", genre: null, energy: 8, size: 3 })
        .mockResolvedValueOnce(OLLAMA_PLAYLIST_RESPONSE);

      const result = await builder.generateFromPrompt("workout banger playlist");
      expect(result).toHaveProperty("tracks");
      expect(Array.isArray(result.tracks)).toBe(true);
    });

    it("faz fallback para metadata pre-filter quando searchByText retorna vazio", async () => {
      const embSvc = makeEmbeddingService([]); // store vazio
      builder = new PlaylistBuilder({ allfather, libraryScanner, embeddingService: embSvc, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "happy", genre: null, energy: null, size: 3 })
        .mockResolvedValueOnce(OLLAMA_PLAYLIST_RESPONSE);

      const result = await builder.generateFromPrompt("happy morning songs");
      // Deve usar todas as faixas da biblioteca como pool (metadata filter)
      const selectionPrompt = allfather.askForJSON.mock.calls[1][0];
      expect(selectionPrompt).toContain("Karma Police"); // está na biblioteca completa
      expect(result.prompt).toBe("happy morning songs");
    });

    it("retorna playlist vazia (graceful) quando LLM de seleção falha", async () => {
      const embSvc = makeEmbeddingService([{ ratingKey: "31", similarity: 0.9 }]);
      builder = new PlaylistBuilder({ allfather, libraryScanner, embeddingService: embSvc, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: null, genre: null, energy: null, size: 2 })
        .mockRejectedValueOnce(new Error("Ollama timeout"));

      const result = await builder.generateFromPrompt("any music");
      expect(result).toHaveProperty("id");
      expect(result.tracks).toEqual([]);
      expect(result.prompt).toBe("any music");
    });

    it("o searchByText é chamado com o prompt exato", async () => {
      const embSvc = makeEmbeddingService([]);
      builder = new PlaylistBuilder({ allfather, libraryScanner, embeddingService: embSvc, storageFile: false });

      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: null, genre: null, energy: null, size: 2 })
        .mockResolvedValueOnce([]);

      await builder.generateFromPrompt("deep focus instrumental");
      expect(embSvc.searchByText).toHaveBeenCalledWith("deep focus instrumental", expect.any(Number));
    });
  });

  // ── _diversifyArtists() ───────────────────────────────────────────────────

  describe("_diversifyArtists()", () => {
    const MANY_TRACKS = [
      { ratingKey: "1", title: "Track A1", grandparentTitle: "ArtistA", parentTitle: "Album1" },
      { ratingKey: "2", title: "Track A2", grandparentTitle: "ArtistA", parentTitle: "Album2" },
      { ratingKey: "3", title: "Track A3", grandparentTitle: "ArtistA", parentTitle: "Album3" },
      { ratingKey: "4", title: "Track B1", grandparentTitle: "ArtistB", parentTitle: "Album4" },
      { ratingKey: "5", title: "Track B2", grandparentTitle: "ArtistB", parentTitle: "Album5" },
      { ratingKey: "6", title: "Track C1", grandparentTitle: "ArtistC", parentTitle: "Album6" },
    ];

    it("limita faixas por artista ao máximo calculado", () => {
      // Para size=4: maxPerArtist = min(5, max(2, ceil(4/25))) = 2
      const result = builder._diversifyArtists(MANY_TRACKS, MANY_TRACKS, 4);
      const countA = result.filter(t => t.grandparentTitle === 'ArtistA').length;
      expect(countA).toBeLessThanOrEqual(2);
      expect(result.length).toBe(4);
    });

    it("mantém tamanho correto mesmo quando Ollama retorna artistas repetidos", () => {
      // Ollama escolhe só ArtistA (3 faixas), generate deve completar de outros
      const ollamaSelected = MANY_TRACKS.filter(t => t.grandparentTitle === 'ArtistA');
      const result = builder._diversifyArtists(ollamaSelected, MANY_TRACKS, 4);
      expect(result.length).toBe(4);
      const uniqueArtists = new Set(result.map(t => t.grandparentTitle)).size;
      expect(uniqueArtists).toBeGreaterThan(1);
    });

    it("não duplica faixas no resultado", () => {
      const result = builder._diversifyArtists(MANY_TRACKS, MANY_TRACKS, 5);
      const keys = result.map(t => t.ratingKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("respeita count máximo", () => {
      const result = builder._diversifyArtists(MANY_TRACKS, MANY_TRACKS, 3);
      expect(result.length).toBe(3);
    });
  });

  // ── _ensureDiscovery() ────────────────────────────────────────────────────

  describe("_ensureDiscovery()", () => {
    // Pool com mix de faixas muito ouvidas e nunca ouvidas
    const POOL_WITH_PLAYS = [
      { ratingKey: "10", title: "Hit 1",      grandparentTitle: "Pop", viewCount: 80 },
      { ratingKey: "11", title: "Hit 2",      grandparentTitle: "Pop", viewCount: 60 },
      { ratingKey: "12", title: "Hit 3",      grandparentTitle: "Pop", viewCount: 40 },
      { ratingKey: "13", title: "Obscure 1",  grandparentTitle: "Jazz", viewCount: 1 },
      { ratingKey: "14", title: "Obscure 2",  grandparentTitle: "Jazz", viewCount: 0 },
      { ratingKey: "15", title: "Obscure 3",  grandparentTitle: "Rock", viewCount: 0 },
      { ratingKey: "16", title: "Obscure 4",  grandparentTitle: "Rock", viewCount: 2 },
      { ratingKey: "17", title: "Mid 1",      grandparentTitle: "Soul", viewCount: 20 },
      { ratingKey: "18", title: "Mid 2",      grandparentTitle: "Soul", viewCount: 15 },
      { ratingKey: "19", title: "Obscure 5",  grandparentTitle: "Blues", viewCount: 0 },
    ];

    it("garante ≥30% de faixas discovery quando seleção tem só hits", () => {
      // selected = 4 hits (nenhuma discovery)
      const selected = POOL_WITH_PLAYS.slice(0, 4);
      const result = builder._ensureDiscovery(selected, POOL_WITH_PLAYS, 4);

      // discovery são faixas com viewCount baixo (bottom 40% do pool sorted)
      // pool sorted: 0,0,0,0,1,2,15,20,40,60,80 → bottom 40% (4 items) = viewCount 0,0,0,0
      const discoveryKeys = new Set(
        [...POOL_WITH_PLAYS].sort((a,b) => (a.viewCount||0) - (b.viewCount||0))
          .slice(0, Math.ceil(POOL_WITH_PLAYS.length * 0.4))
          .map(t => t.ratingKey)
      );
      const discoveryCount = result.filter(t => discoveryKeys.has(t.ratingKey)).length;
      const minRequired = Math.ceil(4 * 0.30);
      expect(discoveryCount).toBeGreaterThanOrEqual(minRequired);
    });

    it("não altera a seleção quando já tem discovery suficiente", () => {
      // selected = 2 hits + 2 discovery (50% ≥ 30%)
      const selected = [
        POOL_WITH_PLAYS[0], // viewCount 80
        POOL_WITH_PLAYS[1], // viewCount 60
        POOL_WITH_PLAYS[4], // viewCount 0 (discovery)
        POOL_WITH_PLAYS[5], // viewCount 0 (discovery)
      ];
      const result = builder._ensureDiscovery(selected, POOL_WITH_PLAYS, 4);
      // Deve retornar exatamente as mesmas faixas
      expect(result.map(t => t.ratingKey)).toEqual(selected.map(t => t.ratingKey));
    });

    it("mantém o tamanho da seleção inalterado", () => {
      const selected = POOL_WITH_PLAYS.slice(0, 6);
      const result = builder._ensureDiscovery(selected, POOL_WITH_PLAYS, 6);
      expect(result.length).toBe(6);
    });

    it("não duplica faixas no resultado", () => {
      const selected = POOL_WITH_PLAYS.slice(0, 4);
      const result = builder._ensureDiscovery(selected, POOL_WITH_PLAYS, 4);
      const keys = result.map(t => t.ratingKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("funciona gracefully quando pool não tem faixas discovery disponíveis", () => {
      // Pool com apenas hits (todos muito ouvidos)
      const allHits = [
        { ratingKey: "20", title: "H1", grandparentTitle: "A", viewCount: 50 },
        { ratingKey: "21", title: "H2", grandparentTitle: "A", viewCount: 60 },
        { ratingKey: "22", title: "H3", grandparentTitle: "A", viewCount: 70 },
      ];
      const result = builder._ensureDiscovery([...allHits], [...allHits], 3);
      // Não deve lançar erro, apenas retorna o que tem
      expect(result.length).toBeGreaterThan(0);
    });

    it("usa DISCOVERY_RATIO = 0.30 por padrão", () => {
      expect(typeof PlaylistBuilder.DISCOVERY_RATIO).toBe('number');
      expect(PlaylistBuilder.DISCOVERY_RATIO).toBe(0.30);
    });
  });

  // ── Filtro de região ───────────────────────────────────────────────────────

  describe("filtro de região", () => {
    it("_buildCompactPrompt inclui restrição ONLY quando region fornecida", () => {
      const prompt = builder._buildCompactPrompt({
        criteria: "mood: happy",
        trackLines: ["1|Song|Artist|Album"],
        size: 1,
        region: "Brazil",
      });
      expect(prompt).toContain("ONLY tracks from Brazil");
      expect(prompt).toContain("Exclude any track from other countries");
    });

    it("_buildCompactPrompt sem region não inclui restrição geográfica", () => {
      const prompt = builder._buildCompactPrompt({
        criteria: "mood: happy",
        trackLines: ["1|Song|Artist|Album"],
        size: 1,
      });
      expect(prompt).not.toContain("ONLY tracks from");
      expect(prompt).not.toContain("Exclude any track from other countries");
    });

    it("generate() inclui region no critério enviado ao Ollama", async () => {
      await builder.generate({ mood: "happy", region: "Brazil", size: 2 });
      const prompt = allfather.askForJSON.mock.calls[0][0];
      expect(prompt).toContain("Brazil");
      expect(prompt).toContain("ONLY tracks from Brazil");
    });

    it("generateFromPrompt() extrai region do LLM e aplica na seleção", async () => {
      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "happy", genre: "MPB", energy: 5, size: 2, region: "Brazil" })
        .mockResolvedValueOnce([31, 34]);

      await builder.generateFromPrompt("brasilidades animadas");

      const selectionPrompt = allfather.askForJSON.mock.calls[1][0];
      expect(selectionPrompt).toContain("Brazil");
      expect(selectionPrompt).toContain("ONLY tracks from Brazil");
    });

    it("generateFromPrompt() sem region não aplica restrição geográfica", async () => {
      allfather.askForJSON
        .mockResolvedValueOnce({ name: null, mood: "chill", genre: null, energy: null, size: 2, region: null })
        .mockResolvedValueOnce([31, 34]);

      await builder.generateFromPrompt("chill vibes");

      const selectionPrompt = allfather.askForJSON.mock.calls[1][0];
      expect(selectionPrompt).not.toContain("ONLY tracks from");
    });
  });

  // ── Filtro por idioma (_filterByLanguage / _languageScore) ─────────────────

  describe("filtro por idioma", () => {
    const ptTracks = [
      { ratingKey: "100", title: "Garota de Ipanema", grandparentTitle: "João Gilberto", parentTitle: "Chega de Saudade" },
      { ratingKey: "101", title: "Águas de Março",    grandparentTitle: "Tom Jobim",     parentTitle: "Elis & Tom" },
      { ratingKey: "102", title: "Não Me Deixe Só",   grandparentTitle: "Cássia Eller",  parentTitle: "Cássia Eller" },
    ];
    const enTracks = [
      { ratingKey: "200", title: "Comfortably Numb",  grandparentTitle: "Pink Floyd",    parentTitle: "The Wall" },
      { ratingKey: "201", title: "Creep",              grandparentTitle: "Radiohead",     parentTitle: "Pablo Honey" },
    ];
    const allTracks = [...ptTracks, ...enTracks];

    it("_languageScore detecta texto em português com acentos", () => {
      const score = builder._languageScore("Não Me Deixe Só Cássia Eller Cássia Eller", "Brazil");
      expect(score).toBeGreaterThan(0);
    });

    it("_languageScore retorna 0 para região desconhecida", () => {
      const score = builder._languageScore("qualquer texto", "Atlantis");
      expect(score).toBe(0);
    });

    it("_languageScore detecta japonês por caracteres CJK/hiragana/katakana", () => {
      const score = builder._languageScore("東京の夜 アーティスト アルバム", "Japan");
      expect(score).toBeGreaterThan(0);
    });

    it("_filterByLanguage prioriza faixas portuguesas para region=Brazil", () => {
      const result = builder._filterByLanguage(allTracks, "Brazil", 3);
      // matched (3 PT tracks) >= size (3) → retorna apenas matched
      expect(result.length).toBe(3);
      const keys = result.map(t => t.ratingKey);
      expect(keys).toContain("100");
      expect(keys).toContain("101");
      expect(keys).toContain("102");
      expect(keys).not.toContain("200");
      expect(keys).not.toContain("201");
    });

    it("_filterByLanguage retorna pool sem filtro para região desconhecida", () => {
      const result = builder._filterByLanguage(allTracks, "Atlantis", 3);
      expect(result).toEqual(allTracks);
    });

    it("_filterByLanguage retorna pool sem filtro quando sem região", () => {
      const result = builder._filterByLanguage(allTracks, null, 3);
      expect(result).toEqual(allTracks);
    });

    it("_filterByLanguage preenche apenas até `size` candidatos (não size*3)", () => {
      // matched=3 PT, size=5: fill = max(0, 5-3) = 2 não-regionais → total 5
      const result = builder._filterByLanguage(allTracks, "Brazil", 5);
      // matched(3) < size(5) mas matched(3) >= ceil(5*0.3)=2 → preenche até 5
      expect(result.length).toBe(5);
      // matched ficam na frente
      expect(result[0].ratingKey).toBe("100"); // maior score PT
      expect(result.filter(t => ["100","101","102"].includes(t.ratingKey)).length).toBe(3);
      expect(result.filter(t => ["200","201"].includes(t.ratingKey)).length).toBe(2);
    });

    it("_filterByLanguage retorna apenas matched quando matched >= size", () => {
      // matched=3 PT, size=2: only Brazilian returned
      const result = builder._filterByLanguage(allTracks, "Brazil", 2);
      expect(result.length).toBe(3);
      result.forEach(t => expect(["100","101","102"]).toContain(t.ratingKey));
    });

    it("_filterByLanguage usa fallback se matched < 30% do size", () => {
      // Só 1 faixa PT num pool de 5, tamanho pedido grande (size=10): matched(1) < ceil(10*0.3)=3
      const bigEnTracks = Array.from({ length: 8 }, (_, i) => ({
        ratingKey: String(300 + i), title: `Song ${i}`, grandparentTitle: "Artist", parentTitle: "Album",
      }));
      const pool = [ptTracks[0], ...bigEnTracks];
      const result = builder._filterByLanguage(pool, "Brazil", 10);
      // matched=1 < ceil(10*0.3)=3 → sem filtro
      expect(result).toEqual(pool);
    });

    it("generate() com region filtra biblioteca COMPLETA (não apenas pré-seleção)", async () => {
      const libScanner = makeLibraryScanner([...ptTracks, ...enTracks]);
      const af = makeAllFather();
      af.askForJSON.mockResolvedValue(["100"]);
      const b = new PlaylistBuilder({ allfather: af, libraryScanner: libScanner, storageFile: false });

      await b.generate({ region: "Brazil", size: 2 });

      const selPrompt = af.askForJSON.mock.calls[0][0];
      // Faixas PT devem aparecer; EN NÃO devem aparecer no pool
      expect(selPrompt).toContain("Garota de Ipanema");
      expect(selPrompt).toContain("ONLY tracks from Brazil");
      expect(selPrompt).not.toContain("Comfortably Numb");
      expect(selPrompt).not.toContain("Creep");
    });

    it("generate() com região filtra mesmo com 200 tracks inglesas e só 2 PT", async () => {
      const manyEn = Array.from({ length: 200 }, (_, i) => ({
        ratingKey: String(400 + i), title: `Song ${i}`, grandparentTitle: `Artist ${i}`, parentTitle: `Album ${i}`,
      }));
      const fewPt = [
        { ratingKey: "501", title: "Asa Branca", grandparentTitle: "Luiz Gonzaga",   parentTitle: "Forró Pé de Serra" },
        { ratingKey: "502", title: "Carcará",    grandparentTitle: "Maria Bethânia",  parentTitle: "Show da Bethânia" },
      ];
      const libScanner = makeLibraryScanner([...manyEn, ...fewPt]);
      const af = makeAllFather();
      af.askForJSON.mockResolvedValue(["501", "502"]);
      const b = new PlaylistBuilder({ allfather: af, libraryScanner: libScanner, storageFile: false });

      await b.generate({ region: "Brazil", size: 2 });

      const selPrompt = af.askForJSON.mock.calls[0][0];
      expect(selPrompt).toContain("Asa Branca");
      expect(selPrompt).toContain("ONLY tracks from Brazil");
    });
  });
  // ── filtro de favoritos (fase 4) ─────────────────────────────────────────

  describe("generateFromCacheWithPrompt() com favoriteKeys", () => {
    const CACHE_ENTRIES = [
      { ratingKey: "30", title: "Money",        artist: "Pink Floyd", album: "The Dark Side of the Moon", analysis: { genre: "Rock", energy: 5 } },
      { ratingKey: "31", title: "Karma Police", artist: "Radiohead",  album: "OK Computer",               analysis: { genre: "Rock", energy: 4 } },
    ];
    const analysisCache = { getAll: () => CACHE_ENTRIES };

    it("estoura com mensagem acionável quando nenhuma faixa do cache é favorita", async () => {
      const favoriteKeys = new Set([FavoritesService.makeKey("Ninguem", "Nada", "Nunca")]);

      await expect(
        builder.generateFromCacheWithPrompt("qualquer coisa", analysisCache, { favoriteKeys })
      ).rejects.toThrow(/favorita/i);

      // Filtrou antes de gastar chamada de LLM
      expect(allfather.askForJSON).not.toHaveBeenCalled();
    });

    it("sem favoriteKeys não filtra o cache", async () => {
      allfather.askForJSON.mockResolvedValue([30]);

      await expect(
        builder.generateFromCacheWithPrompt("qualquer coisa", analysisCache, {})
      ).resolves.toBeDefined();
    });
  });
});
