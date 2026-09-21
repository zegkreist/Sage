import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { HermesInboxService } from "../../src/services/HermesInboxService.js";

describe("HermesInboxService", () => {
  let dataDir;
  let svc;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-"));
    svc = new HermesInboxService({ dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const writeRequests = (content) => {
    fs.mkdirSync(svc.dir, { recursive: true });
    fs.writeFileSync(svc.requests, content);
  };

  describe("parseRequest()", () => {
    test("separa artista e título no travessão", () => {
      const p = HermesInboxService.parseRequest("Radiohead — OK Computer");
      expect(p).toMatchObject({ artist: "Radiohead", title: "OK Computer" });
    });

    test("aceita hífen, pipe e dois-pontos como separador", () => {
      expect(HermesInboxService.parseRequest("Beatles - Abbey Road").artist).toBe("Beatles");
      expect(HermesInboxService.parseRequest("Caetano | Transa").artist).toBe("Caetano");
      expect(HermesInboxService.parseRequest("Sepultura: Roots").artist).toBe("Sepultura");
    });

    test("não corta no dois-pontos quando já existe um separador melhor", () => {
      const p = HermesInboxService.parseRequest("Guns N' Roses — Use Your Illusion II: The Return");
      expect(p.artist).toBe("Guns N' Roses");
      expect(p.title).toBe("Use Your Illusion II: The Return");
    });

    test("#track implica origem Tidal — torrent é sempre álbum", () => {
      const p = HermesInboxService.parseRequest("Miles Davis — So What #track");
      expect(p).toMatchObject({ kind: "track", source: "tidal" });
      expect(p.title).toBe("So What"); // tag não vaza para o título
    });

    test("#torrent força a origem torrent e implica álbum", () => {
      const p = HermesInboxService.parseRequest("Pink Floyd — Animals #torrent");
      expect(p.source).toBe("torrent");
      expect(p.kind).toBe("album");   // torrent não distribui faixa avulsa
    });

    test("aceita tag entre parênteses além de #", () => {
      expect(HermesInboxService.parseRequest("Tom Jobim — Wave (album)").kind).toBe("album");
    });

    test("link de faixa do Tidal vira kind=track via tidal", () => {
      const p = HermesInboxService.parseRequest("https://tidal.com/browse/track/12345678");
      expect(p).toMatchObject({ kind: "track", source: "tidal" });
      expect(p.tidalUrl).toBe("https://tidal.com/browse/track/12345678");
    });

    test("link de álbum do Tidal vira kind=album via tidal", () => {
      const p = HermesInboxService.parseRequest("https://tidal.com/browse/album/77654321");
      expect(p).toMatchObject({ kind: "album", source: "tidal" });
    });

    test("nome + link: o link define a origem e o nome continua legível", () => {
      const p = HermesInboxService.parseRequest("Chico — Construção — https://tidal.com/browse/track/999");
      expect(p.artist).toBe("Chico");
      expect(p.title).toBe("Construção");
      expect(p.tidalUrl).toBe("https://tidal.com/browse/track/999");
      expect(p.kind).toBe("track");
    });

    test("texto livre sem separador vira busca simples", () => {
      const p = HermesInboxService.parseRequest("trilha do bladerunner");
      expect(p.artist).toBeNull();
      expect(p.title).toBe("trilha do bladerunner");
    });

    test("link markdown mantém só o rótulo", () => {
      const p = HermesInboxService.parseRequest("[Bowie — Heroes](https://tidal.com/browse/album/42)");
      expect(p.artist).toBe("Bowie");
      expect(p.title).toBe("Heroes");
    });
  });

  describe("roteamento (origem e tipo)", () => {
    // Regressão: o padrão era torrent, então toda linha "Artista — Música" sem
    // tag ia parar no Stormbringer — o oposto do esperado numa lista de músicas.
    test("pedido sem tag vai para o Tidal, não para o torrent", () => {
      const p = HermesInboxService.parseRequest("Radiohead — Creep");
      expect(p.source).toBe("tidal");
    });

    test("sem tag e sem link, o tipo fica 'unknown' em vez de chutar álbum", () => {
      expect(HermesInboxService.parseRequest("Radiohead — Creep").kind).toBe("unknown");
    });

    test("só #torrent tira o pedido do Tidal", () => {
      expect(HermesInboxService.parseRequest("Radiohead — Creep #torrent").source).toBe("torrent");
      expect(HermesInboxService.parseRequest("Radiohead — Creep #album").source).toBe("tidal");
      expect(HermesInboxService.parseRequest("Radiohead — Creep #tidal").source).toBe("tidal");
    });

    test("todo pedido explica por que caiu na rota que caiu", () => {
      expect(HermesInboxService.parseRequest("Radiohead — Creep").reason)
        .toMatch(/tidal.*padrão.*#torrent/i);
      expect(HermesInboxService.parseRequest("A — B #torrent").reason)
        .toMatch(/torrent.*tag #torrent/i);
      expect(HermesInboxService.parseRequest("https://tidal.com/browse/track/9").reason)
        .toMatch(/link do Tidal/i);
    });
  });

  describe("makeId()", () => {
    test("é estável para o mesmo texto e ignora espaçamento", () => {
      expect(HermesInboxService.makeId("Radiohead — Creep"))
        .toBe(HermesInboxService.makeId("  radiohead   —  creep "));
    });

    test("difere entre pedidos diferentes", () => {
      expect(HermesInboxService.makeId("A — B")).not.toBe(HermesInboxService.makeId("A — C"));
    });
  });

  describe("list()", () => {
    test("retorna vazio quando requests.md não existe", () => {
      expect(svc.list()).toEqual([]);
    });

    test("lê só os itens pendentes e ignora prosa em volta", () => {
      writeRequests([
        "# Pedidos",
        "",
        "Texto que o Hermes escreveu explicando o contexto.",
        "",
        "- [ ] Radiohead — OK Computer",
        "* [ ] Miles Davis — So What #track",
        "",
        "> nota de rodapé",
      ].join("\n"));

      const items = svc.list();
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ artist: "Radiohead", title: "OK Computer" });
      expect(items[1]).toMatchObject({ artist: "Miles Davis", kind: "track" });
      expect(items[0].id).toMatch(/^[0-9a-f]{12}$/);
    });

    test("linha marcada [x] à mão é arquivada e some do requests.md", () => {
      writeRequests([
        "- [x] Beatles — Revolver",
        "- [ ] Radiohead — OK Computer",
      ].join("\n"));

      const items = svc.list();

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("OK Computer");
      expect(fs.readFileSync(svc.requests, "utf8")).not.toContain("Revolver");
      expect(fs.readFileSync(svc.done, "utf8")).toContain("Beatles — Revolver");
      expect(fs.readFileSync(svc.done, "utf8")).toContain("marcado à mão");
    });
  });

  describe("resolve()", () => {
    test("remove a linha concluída e preserva o resto do arquivo byte a byte", () => {
      writeRequests([
        "# Pedidos do Hermes",
        "",
        "Contexto importante que não pode sumir.",
        "",
        "- [ ] Radiohead — OK Computer",
        "- [ ] Beatles — Revolver",
        "",
        "<!-- comentário do Hermes -->",
      ].join("\n"));

      const target = svc.list().find(i => i.title === "OK Computer");
      const res = svc.resolve(target.id, { status: "done", source: "torrent" });

      expect(res.ok).toBe(true);
      const after = fs.readFileSync(svc.requests, "utf8");
      expect(after).not.toContain("OK Computer");
      expect(after).toContain("# Pedidos do Hermes");
      expect(after).toContain("Contexto importante que não pode sumir.");
      expect(after).toContain("- [ ] Beatles — Revolver");
      expect(after).toContain("<!-- comentário do Hermes -->");
    });

    test("registra em done.md com data e origem", () => {
      writeRequests("- [ ] Radiohead — OK Computer");
      const [item] = svc.list();

      svc.resolve(item.id, { status: "done", source: "tidal", detail: "3 faixas" });

      const done = fs.readFileSync(svc.done, "utf8");
      expect(done).toContain("Radiohead — OK Computer");
      expect(done).toContain("via tidal");
      expect(done).toContain("3 faixas");
      expect(done).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    });

    test("marca origem e status quando o item foi pulado", () => {
      writeRequests("- [ ] Radiohead — OK Computer");
      const [item] = svc.list();

      svc.resolve(item.id, { status: "skipped", detail: "já está na biblioteca" });

      expect(fs.readFileSync(svc.done, "utf8")).toContain("(skipped)");
    });

    test("id inexistente não altera o arquivo", () => {
      writeRequests("- [ ] Radiohead — OK Computer");
      const before = fs.readFileSync(svc.requests, "utf8");

      const res = svc.resolve("deadbeef0000");

      expect(res.ok).toBe(false);
      expect(fs.readFileSync(svc.requests, "utf8")).toBe(before);
    });

    test("remove apenas uma linha quando há duplicatas idênticas", () => {
      writeRequests([
        "- [ ] Radiohead — Creep",
        "- [ ] Radiohead — Creep",
      ].join("\n"));

      const [item] = svc.list();
      svc.resolve(item.id);

      const after = fs.readFileSync(svc.requests, "utf8");
      expect(after.match(/Creep/g)).toHaveLength(1);
    });
  });

  describe("writeStatus()", () => {
    test("escreve biblioteca, pendentes e fila", () => {
      svc.writeStatus({
        library: { artists: 12, albums: 40, tracks: 500 },
        pending: [{ text: "Radiohead — OK Computer", kind: "album", source: "torrent" }],
        queue: [{ source: "tidal", title: "TideCaller — faixas", status: "running", pct: 50 }],
        recentErrors: [{ source: "tidal", title: "X", error: "Token inválido" }],
      });

      const md = fs.readFileSync(svc.status, "utf8");
      expect(md).toContain("# Status do Sage");
      expect(md).toContain("Artistas: 12");
      expect(md).toContain("Radiohead — OK Computer");
      expect(md).toContain("**running**");
      expect(md).toContain("Token inválido");
    });

    test("descreve os vazios em vez de omitir a seção", () => {
      svc.writeStatus({});
      const md = fs.readFileSync(svc.status, "utf8");
      expect(md).toContain("Indisponível");
      expect(md).toContain("`requests.md` está vazio");
      expect(md).toContain("_Vazia._");
    });
  });

  describe("permissões", () => {
    // O container roda como root e /data é bind mount: sem chmod explícito
    // tudo sai 0644 root-owned e o Hermes fica sem escrita.
    const modeOf = (f) => fs.statSync(f).mode & 0o777;

    test("a pasta e o requests.md nascem graváveis por qualquer usuário", () => {
      svc.ensureScaffold();

      expect(modeOf(svc.dir)).toBe(0o777);      // tmp+rename exige escrita na pasta
      expect(modeOf(svc.requests)).toBe(0o666);
    });

    test("os arquivos que só o Sage escreve não ficam graváveis por todos", () => {
      svc.ensureScaffold();
      expect(modeOf(svc.readme) & 0o022).toBe(0);
    });

    test("concluir um pedido NÃO devolve o requests.md para 0644", () => {
      // Regressão: _writeAtomic troca o inode no rename, então sem preservar
      // a permissão o Hermes perderia a escrita na primeira conclusão.
      svc.ensureScaffold();
      fs.writeFileSync(svc.requests, "- [ ] Radiohead — Creep");
      fs.chmodSync(svc.requests, 0o666);

      const [item] = svc.list();
      svc.resolve(item.id, { status: "done" });

      expect(modeOf(svc.requests)).toBe(0o666);
    });

    test("status.md reescrito mantém a permissão que tinha", () => {
      svc.ensureScaffold();
      svc.writeStatus({});
      fs.chmodSync(svc.status, 0o660);

      svc.writeStatus({ library: { artists: 1, albums: 1, tracks: 1 } });

      expect(modeOf(svc.status)).toBe(0o660);
    });

    test("conserta um requests.md que já existia apertado", () => {
      writeRequests("- [ ] pedido antigo");
      fs.chmodSync(svc.requests, 0o600);

      svc.ensureScaffold();

      expect(modeOf(svc.requests)).toBe(0o666);
      // e o conteúdo do Hermes continua intacto
      expect(fs.readFileSync(svc.requests, "utf8")).toBe("- [ ] pedido antigo");
    });
  });

  describe("ensureScaffold()", () => {
    test("cria README e requests.md na primeira vez", () => {
      svc.ensureScaffold();

      expect(fs.existsSync(svc.readme)).toBe(true);
      expect(fs.readFileSync(svc.readme, "utf8")).toContain("Canal de controle do Sage");
      expect(fs.readFileSync(svc.requests, "utf8")).toContain("- [ ]");
    });

    test("não sobrescreve requests.md existente — o dono é o Hermes", () => {
      writeRequests("- [ ] pedido que já estava lá");
      svc.ensureScaffold();

      expect(fs.readFileSync(svc.requests, "utf8")).toBe("- [ ] pedido que já estava lá");
    });

    test("regenera o README mesmo se já existir", () => {
      fs.mkdirSync(svc.dir, { recursive: true });
      fs.writeFileSync(svc.readme, "conteúdo velho");
      svc.ensureScaffold();

      expect(fs.readFileSync(svc.readme, "utf8")).not.toBe("conteúdo velho");
    });
  });
});
