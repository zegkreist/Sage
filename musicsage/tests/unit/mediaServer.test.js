import { jest } from "@jest/globals";

import { MediaServerProvider, NotImplementedError } from "../../src/media/MediaServerProvider.js";
import { PlexProvider } from "../../src/media/PlexProvider.js";
import { createMediaServer, supportedMediaServers } from "../../src/media/index.js";

const fakeAxios = () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() });

describe("MediaServerProvider (contrato)", () => {
  const provider = new MediaServerProvider();

  it.each(["library", "history", "metrics", "playlists"])(
    "getter '%s' não implementado estoura NotImplementedError",
    (membro) => {
      expect(() => provider[membro]).toThrow(NotImplementedError);
    }
  );

  it.each(["getUsers", "checkConnection"])("método '%s' não implementado rejeita", async (m) => {
    await expect(provider[m]()).rejects.toThrow(NotImplementedError);
  });

  it("ratings vem desligado por padrão — provider sem notas não quebra nada", async () => {
    expect(provider.ratings.supported).toBe(false);
    await expect(provider.ratings.setTrackRating("1", 5)).rejects.toThrow(NotImplementedError);
  });

  it("a mensagem de erro diz qual provider e qual membro faltam", () => {
    class Meio extends MediaServerProvider { static type = "meio"; }
    expect(() => new Meio().library).toThrow(/"meio".*"library"/);
  });
});

describe("createMediaServer", () => {
  it("cria o provider do Plex por padrão", () => {
    const media = createMediaServer({ axios: fakeAxios() });
    expect(media).toBeInstanceOf(PlexProvider);
    expect(media.type).toBe("plex");
  });

  it("servidor desconhecido estoura dizendo o que existe e onde registrar", () => {
    expect(() => createMediaServer({ type: "jellyfin", axios: fakeAxios() }))
      .toThrow(/jellyfin.*não suportado.*plex.*src\/media/s);
  });

  it("é case-insensitive no tipo", () => {
    expect(createMediaServer({ type: "PLEX", axios: fakeAxios() }).type).toBe("plex");
  });

  it("supportedMediaServers lista os registrados", () => {
    expect(supportedMediaServers()).toContain("plex");
  });
});

describe("PlexProvider", () => {
  const make = (over = {}) =>
    new PlexProvider({ axios: fakeAxios(), url: "http://plex:32400", token: "abcd1234", ...over });

  it("cumpre o contrato inteiro sem estourar", () => {
    const p = make();
    for (const membro of ["library", "history", "metrics", "playlists"]) {
      expect(p[membro]).toBeDefined();
    }
    expect(typeof p.getUsers).toBe("function");
    expect(typeof p.checkConnection).toBe("function");
  });

  it("expõe a API de biblioteca que o app consome", () => {
    const { library } = make();
    for (const m of ["scan", "getArtistNames", "getGenres", "getArtistsWithGenres", "getLibraryStats"]) {
      expect(typeof library[m]).toBe("function");
    }
  });

  it("expõe a API de playlists que o app consome", () => {
    const { playlists } = make();
    for (const m of ["pushPlaylist", "renamePlaylist", "updatePlaylistTracks", "deletePlaylist"]) {
      expect(typeof playlists[m]).toBe("function");
    }
  });

  it("suporta notas e delega para o PlexService", async () => {
    const p = make();
    p._plex.setRating = jest.fn().mockResolvedValue();

    expect(p.ratings.supported).toBe(true);
    await p.ratings.setTrackRating("42", 4);

    expect(p._plex.setRating).toHaveBeenCalledWith("42", 4);
  });

  it("describe() mascara o token", () => {
    expect(make().describe()).toEqual({
      type: "plex", url: "http://plex:32400", tokenPresent: true, tokenMasked: "abcd****",
    });
  });

  it("describe() sinaliza token ausente", () => {
    expect(make({ token: "" }).describe()).toMatchObject({ tokenPresent: false, tokenMasked: "(vazio)" });
  });

  it("applyToken propaga para os quatro serviços — todos batem no mesmo servidor", () => {
    const p = make();
    p.applyToken("novotoken");
    for (const svc of [p._library, p._history, p._metrics, p._plex]) {
      expect(svc.plexToken).toBe("novotoken");
    }
  });
});
