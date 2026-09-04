import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import { WeeklyDiscoveryService } from "../../src/services/WeeklyDiscoveryService.js";
import { FavoritesService } from "../../src/services/FavoritesService.js";

// 2026-09-07 é uma segunda-feira — o dia padrão do agendador
const SEGUNDA_9H  = new Date(2026, 8, 7, 9, 0, 0).getTime();
const SEGUNDA_6H  = new Date(2026, 8, 7, 6, 0, 0).getTime();
const DOMINGO_23H = new Date(2026, 8, 6, 23, 0, 0).getTime();

const CACHE_ENTRIES = [
  { ratingKey: "1", title: "Esquecida",  artist: "A", album: "X", analysis: { genre: "Rock" } },
  { ratingKey: "2", title: "Batidona",   artist: "B", album: "Y", analysis: { genre: "Rock" } },
  { ratingKey: "3", title: "Predileta",  artist: "C", album: "Z", analysis: { genre: "Jazz" } },
];

function makeDeps({ dataDir, now, viewCounts = { "1": 0, "2": 90, "3": 5 } } = {}) {
  const favoritesService = new FavoritesService({ dataDir });
  const playlistBuilder = {
    generateFromCacheWithPrompt: jest.fn().mockResolvedValue({
      name: "gerada", tracks: [{ ratingKey: "1" }, { ratingKey: "3" }],
    }),
    save:   jest.fn().mockImplementation((p) => ({ ...p, id: "pl-1" })),
    update: jest.fn(),
  };
  return {
    playlistBuilder,
    favoritesService,
    analysisCache: { getAll: () => CACHE_ENTRIES },
    libraryScanner: {
      scan: jest.fn().mockResolvedValue({
        tracks: Object.entries(viewCounts).map(([ratingKey, viewCount]) => ({ ratingKey, viewCount })),
      }),
    },
    historyService: { getRecentlyPlayedFull: jest.fn().mockResolvedValue([]) },
    recommendationEngine: { _buildAudioProfile: () => ({ topGenres: ["Rock"], avgEnergy: 6 }) },
    plexService: { pushPlaylist: jest.fn().mockResolvedValue({ plexId: "plex-7" }) },
    dataDir,
    now: () => now,
    sleep: jest.fn().mockResolvedValue(undefined),   // backoff sem esperar de verdade
  };
}

describe("WeeklyDiscoveryService", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "musicsage-weekly-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const make = (over = {}) => {
    const deps = makeDeps({ dataDir, now: SEGUNDA_9H, ...over });
    return { svc: new WeeklyDiscoveryService(deps), deps };
  };

  // ── Agendador ───────────────────────────────────────────────────────────

  describe("isDue()", () => {
    it("desligado nunca está na hora", () => {
      const { svc } = make();
      expect(svc.isDue()).toBe(false);
    });

    it("ligado e nunca rodado: está na hora depois do horário marcado", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true });
      expect(svc.isDue(SEGUNDA_9H)).toBe(true);
    });

    it("antes do horário do dia marcado, ainda não é hora", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true });
      // 6h de segunda: o slot vigente é o da segunda anterior — e ele já foi rodado
      svc.state.lastRunAt = SEGUNDA_6H - 1000;
      expect(svc.isDue(SEGUNDA_6H)).toBe(false);
    });

    it("não roda duas vezes na mesma semana", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true });
      svc.state.lastRunAt = SEGUNDA_9H;
      expect(svc.isDue(SEGUNDA_9H)).toBe(false);
    });

    it("volta a ficar due na semana seguinte", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true });
      svc.state.lastRunAt = SEGUNDA_9H;
      const proximaSegunda = SEGUNDA_9H + 7 * 24 * 60 * 60 * 1000;
      expect(svc.isDue(proximaSegunda)).toBe(true);
    });

    it("domingo à noite ainda pertence ao slot da segunda anterior", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true });
      svc.state.lastRunAt = DOMINGO_23H - 1000;
      expect(svc.isDue(DOMINGO_23H)).toBe(false);
    });
  });

  it("tick() não gera nada quando não é a hora", async () => {
    const { svc, deps } = make();
    await svc.tick();
    expect(deps.playlistBuilder.generateFromCacheWithPrompt).not.toHaveBeenCalled();
  });

  it("start() é idempotente e stop() derruba o timer", () => {
    const { svc } = make();
    svc.start({ intervalMs: 60_000 });
    const t = svc._timer;
    svc.start({ intervalMs: 60_000 });
    expect(svc._timer).toBe(t);
    svc.stop();
    expect(svc._timer).toBeNull();
  });

  // ── Semente ─────────────────────────────────────────────────────────────

  describe("pickCandidates()", () => {
    it("ordena da menos ouvida para a mais ouvida", async () => {
      const { svc } = make();
      const out = await svc.pickCandidates();
      expect(out.map((e) => e.ratingKey)).toEqual(["1", "3", "2"]);
    });

    it("exclui as faixas favoritadas", async () => {
      const { svc, deps } = make();
      deps.favoritesService.setFavorite({ artist: "A", title: "Esquecida", album: "X" }, { starred: true });
      const out = await svc.pickCandidates();
      expect(out.map((e) => e.ratingKey)).not.toContain("1");
    });

    it("nota sem coração não exclui a faixa", async () => {
      const { svc, deps } = make();
      deps.favoritesService.setFavorite({ artist: "A", title: "Esquecida", album: "X" }, { rating: 5 });
      const out = await svc.pickCandidates();
      expect(out.map((e) => e.ratingKey)).toContain("1");
    });

    it("Plex fora não quebra a seleção", async () => {
      const { svc, deps } = make();
      deps.libraryScanner.scan.mockRejectedValue(new Error("Plex offline"));
      const out = await svc.pickCandidates();
      expect(out).toHaveLength(3);
    });
  });

  // ── Geração ─────────────────────────────────────────────────────────────

  describe("run()", () => {
    it("restringe o builder à semente e publica no Plex", async () => {
      const { svc, deps } = make();
      const res = await svc.run();

      const opts = deps.playlistBuilder.generateFromCacheWithPrompt.mock.calls[0][2];
      expect(opts.candidateRatingKeys).toBeInstanceOf(Set);
      expect(opts.candidateRatingKeys.has("1")).toBe(true);

      expect(deps.plexService.pushPlaylist).toHaveBeenCalledWith(res.name, ["1", "3"]);
      expect(deps.playlistBuilder.update).toHaveBeenCalledWith("pl-1", { plexId: "plex-7" });
      expect(res).toMatchObject({ id: "pl-1", plexId: "plex-7", trackCount: 2 });
    });

    it("grava lastRunAt/lastPlaylist e persiste em disco", async () => {
      const { svc } = make();
      await svc.run();

      const reloaded = new WeeklyDiscoveryService({ dataDir }).load();
      expect(reloaded.state.lastRunAt).toBe(SEGUNDA_9H);
      expect(reloaded.state.lastPlaylist).toMatchObject({ id: "pl-1", trackCount: 2 });
      expect(reloaded.state.lastError).toBeNull();
    });

    it("Plex fora não invalida a playlist — ela fica local sem plexId", async () => {
      const { svc, deps } = make();
      deps.plexService.pushPlaylist.mockRejectedValue(new Error("Plex offline"));

      const res = await svc.run();

      expect(res.plexId).toBeNull();
      expect(res.trackCount).toBe(2);
      expect(svc.state.lastError).toBeNull();
    });

    it("Ollama instável: tenta de novo com backoff e sucede", async () => {
      const { svc, deps } = make();
      deps.playlistBuilder.generateFromCacheWithPrompt
        .mockRejectedValueOnce(new Error("Ollama fora do ar"))
        .mockResolvedValue({ name: "gerada", tracks: [{ ratingKey: "1" }] });

      const res = await svc.run();

      expect(deps.playlistBuilder.generateFromCacheWithPrompt).toHaveBeenCalledTimes(2);
      expect(deps.sleep).toHaveBeenCalledTimes(1);
      expect(res.trackCount).toBe(1);
    });

    it("backoff cresce entre as tentativas", async () => {
      const { svc, deps } = make();
      deps.playlistBuilder.generateFromCacheWithPrompt.mockRejectedValue(new Error("Ollama fora do ar"));

      await expect(svc.run()).rejects.toThrow(/Ollama/);

      const esperas = deps.sleep.mock.calls.map(([ms]) => ms);
      expect(esperas).toEqual([3000, 9000]);
    });

    it("falha total fica visível e não re-dispara no mesmo slot", async () => {
      const { svc, deps } = make();
      deps.playlistBuilder.generateFromCacheWithPrompt.mockRejectedValue(new Error("Ollama fora do ar"));
      svc.updateSettings({ enabled: true });

      await expect(svc.run()).rejects.toThrow();

      expect(svc.state.lastError.message).toMatch(/Ollama/);
      expect(svc.isDue(SEGUNDA_9H)).toBe(false);
    });

    it("cache vazio dá erro acionável sem chamar o LLM", async () => {
      const { svc, deps } = make();
      svc.analysisCache = { getAll: () => [] };

      await expect(svc.run({ attempts: 1 })).rejects.toThrow(/analise a biblioteca/i);
      expect(deps.playlistBuilder.generateFromCacheWithPrompt).not.toHaveBeenCalled();
    });

    it("recusa duas execuções simultâneas", async () => {
      const { svc } = make();
      const primeira = svc.run();
      await expect(svc.run()).rejects.toThrow(/em andamento/);
      await primeira;
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────

  describe("updateSettings()", () => {
    it("aceita valores válidos e persiste", () => {
      const { svc } = make();
      svc.updateSettings({ enabled: true, dayOfWeek: 5, hour: 20, size: 30 });

      const reloaded = new WeeklyDiscoveryService({ dataDir }).load();
      expect(reloaded.state).toMatchObject({ enabled: true, dayOfWeek: 5, hour: 20, size: 30 });
    });

    it("ignora valores fora da faixa em vez de gravar lixo", () => {
      const { svc } = make();
      svc.updateSettings({ dayOfWeek: 9, hour: 99, size: 5000 });
      expect(svc.state).toMatchObject({ dayOfWeek: 1, hour: 7, size: 25 });
    });

    it("status() expõe o próximo disparo só quando habilitado", () => {
      const { svc } = make();
      expect(svc.status().nextRunAt).toBeNull();
      svc.updateSettings({ enabled: true });
      expect(svc.status().nextRunAt).toBeGreaterThan(SEGUNDA_9H);
    });
  });

  // ── Feature flag de diversificação ──────────────────────────────────────

  describe("clusterDiversity", () => {
    const clusteringService = {
      cluster: jest.fn().mockReturnValue({
        k: 2,
        clusters: [
          { id: 0, tracks: [{ ratingKey: "1" }, { ratingKey: "3" }] },
          { id: 1, tracks: [{ ratingKey: "2" }] },
        ],
      }),
    };
    const embeddingService = { getStored: () => ({ 1: {}, 2: {}, 3: {} }) };

    beforeEach(() => clusteringService.cluster.mockClear());

    it("desligada, mantém a ordem por menos ouvidas", async () => {
      const deps = makeDeps({ dataDir, now: SEGUNDA_9H });
      const svc = new WeeklyDiscoveryService({ ...deps, embeddingService, clusteringService });
      const out = await svc.pickCandidates();
      expect(out.map((e) => e.ratingKey)).toEqual(["1", "3", "2"]);
      expect(clusteringService.cluster).not.toHaveBeenCalled();
    });

    it("ligada, alterna entre clusters", async () => {
      const deps = makeDeps({ dataDir, now: SEGUNDA_9H });
      const svc = new WeeklyDiscoveryService({ ...deps, embeddingService, clusteringService });
      svc.updateSettings({ clusterDiversity: true });

      const out = await svc.pickCandidates();

      expect(clusteringService.cluster).toHaveBeenCalled();
      expect(out.map((e) => e.ratingKey)).toEqual(["1", "2", "3"]);
    });

    it("sem clusteringService, devolve o pool intacto", async () => {
      const deps = makeDeps({ dataDir, now: SEGUNDA_9H });
      const svc = new WeeklyDiscoveryService(deps);
      svc.updateSettings({ clusterDiversity: true });
      const out = await svc.pickCandidates();
      expect(out).toHaveLength(3);
    });
  });
});
