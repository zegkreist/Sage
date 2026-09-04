import { jest } from "@jest/globals";
import { PlexService } from "../../src/services/PlexService.js";

describe("PlexService.setRating()", () => {
  let axios;
  let svc;

  beforeEach(() => {
    axios = { put: jest.fn().mockResolvedValue({ data: {} }) };
    svc = new PlexService({ axios, plexUrl: "http://plex:32400", plexToken: "tok" });
  });

  const paramsDaChamada = () => axios.put.mock.calls[0][2].params;

  it("dobra a nota: o Plex trabalha em 0-10, o MusicSage em 0-5", async () => {
    await svc.setRating("42", 4);
    expect(paramsDaChamada()).toMatchObject({ key: "42", rating: 8, identifier: "com.plexapp.plugins.library" });
  });

  it("5 estrelas viram o máximo do Plex", async () => {
    await svc.setRating("42", 5);
    expect(paramsDaChamada().rating).toBe(10);
  });

  it("nota nula limpa a avaliação (rating=-1)", async () => {
    await svc.setRating("42", null);
    expect(paramsDaChamada().rating).toBe(-1);
  });

  it("zero é nota válida, não limpeza", async () => {
    await svc.setRating("42", 0);
    expect(paramsDaChamada().rating).toBe(0);
  });

  it("arredonda meia-estrela e trava no teto", async () => {
    await svc.setRating("42", 3.4);
    expect(paramsDaChamada().rating).toBe(7);

    axios.put.mockClear();
    await svc.setRating("42", 99);
    expect(axios.put.mock.calls[0][2].params.rating).toBe(10);
  });

  it("manda o token e usa PUT em /:/rate com timeout", async () => {
    await svc.setRating("42", 3);
    const [url, body, cfg] = axios.put.mock.calls[0];
    expect(url).toBe("http://plex:32400/:/rate");
    expect(body).toBeNull();
    expect(cfg.headers["X-Plex-Token"]).toBe("tok");
    expect(cfg.timeout).toBeGreaterThan(0);
  });

  it("recusa faixa sem id em vez de mandar request inválido", async () => {
    await expect(svc.setRating("", 3)).rejects.toThrow(/ratingKey/);
    expect(axios.put).not.toHaveBeenCalled();
  });
});
