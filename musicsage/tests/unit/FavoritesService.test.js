import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import { FavoritesService } from "../../src/services/FavoritesService.js";

describe("FavoritesService", () => {
  let dataDir;
  let svc;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "musicsage-fav-"));
    svc = new FavoritesService({ dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("makeKey normaliza caixa, acentos-símbolo e pontuação", () => {
    expect(FavoritesService.makeKey("Led Zeppelin", "Black Dog", "Led Zeppelin IV"))
      .toBe(FavoritesService.makeKey("led  zeppelin!", "black-dog", "LED_ZEPPELIN_IV"));
  });

  it("setFavorite persiste e load() recupera do disco", () => {
    svc.setFavorite({ artist: "Portishead", title: "Roads", album: "Dummy" }, { starred: true });

    const reloaded = new FavoritesService({ dataDir }).load();
    const entry = reloaded.get("Portishead", "Roads", "Dummy");
    expect(entry).toMatchObject({ artist: "Portishead", title: "Roads", starred: true });
  });

  it("rating é clampado em 0-5 e arredondado", () => {
    const a = svc.setFavorite({ artist: "A", title: "T" }, { rating: 9 });
    expect(a.rating).toBe(5);
    const b = svc.setFavorite({ artist: "B", title: "T" }, { rating: 3.6 });
    expect(b.rating).toBe(4);
  });

  it("favorito sem estrela e sem nota é removido em vez de persistir vazio", () => {
    svc.setFavorite({ artist: "A", title: "T" }, { starred: true });
    expect(svc.get("A", "T")).not.toBeNull();

    const res = svc.setFavorite({ artist: "A", title: "T" }, { starred: false });
    expect(res).toBeNull();
    expect(svc.get("A", "T")).toBeNull();
  });

  it("starredKeys traz só os com coração, não os que têm apenas nota", () => {
    svc.setFavorite({ artist: "A", title: "T1" }, { starred: true });
    svc.setFavorite({ artist: "B", title: "T2" }, { rating: 4 });

    const keys = svc.starredKeys();
    expect(keys.size).toBe(1);
    expect(keys.has(FavoritesService.makeKey("A", "T1", ""))).toBe(true);
  });

  it("setFavorite preserva a nota ao mexer só na estrela", () => {
    svc.setFavorite({ artist: "A", title: "T" }, { rating: 4 });
    const entry = svc.setFavorite({ artist: "A", title: "T" }, { starred: true });
    expect(entry).toMatchObject({ starred: true, rating: 4 });
  });

  it("remove devolve false quando a faixa não é favorita", () => {
    expect(svc.remove("Nada", "Disso", "Existe")).toBe(false);
    svc.setFavorite({ artist: "A", title: "T" }, { starred: true });
    expect(svc.remove("A", "T", "")).toBe(true);
  });

  it("load() ignora arquivo ausente sem estourar", () => {
    expect(() => new FavoritesService({ dataDir: path.join(dataDir, "vazio") }).load()).not.toThrow();
  });
});
