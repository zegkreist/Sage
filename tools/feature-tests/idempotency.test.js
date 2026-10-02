/**
 * FEATURE: idempotência — rodar o Transporter 2x NÃO duplica nem corrompe.
 */
import fs from "fs";
import path from "path";
import { beforeEach, afterEach, describe, expect, test } from "@jest/globals";
import { MusicOrganizer } from "../../agents/Transporter/src/musicOrganizer.js";
import { makeTmp, touch, rmRf, makeStreamripRelease, makeTorrentRelease } from "./helpers.js";

let src, dest;
beforeEach(() => {
  src = makeTmp("idem-src-");
  dest = makeTmp("idem-dest-");
});
afterEach(() => {
  rmRf(src);
  rmRf(dest);
});

describe("MusicOrganizer — idempotência (2 runs)", () => {
  test("rodar 2x sobre fonte streamrip: nada duplica na 2ª passada", async () => {
    makeStreamripRelease(src, "Massive Attack", "Mezzanine", "1998", 3);

    const r1 = new MusicOrganizer(dest);
    await r1.processSource(src, "TideCaller");

    const albumDir = path.join(dest, "Massive Attack", "Mezzanine (1998)");
    const afterRun1 = fs.readdirSync(albumDir).filter((f) => f.endsWith(".flac"));
    expect(afterRun1).toHaveLength(3);

    // 2ª rodada com o MESMO conteúdo reaparecido na fonte (simula re-download)
    makeStreamripRelease(src, "Massive Attack", "Mezzanine", "1998", 3);
    const r2 = new MusicOrganizer(dest);
    await r2.processSource(src, "TideCaller");

    const afterRun2 = fs.readdirSync(albumDir).filter((f) => f.endsWith(".flac"));
    expect(afterRun2.sort()).toEqual(afterRun1.sort());
  });

  test("source idêntico processado 2x na mesma sessão (mesmo organizer) não duplica", async () => {
    makeTorrentRelease(src, "Artist", "Album", 2);
    // recria a mesma pasta depois que a 1ª rodada apagou
    const r1 = new MusicOrganizer(dest);
    await r1.processSource(src, "Test");
    makeTorrentRelease(src, "Artist", "Album", 2);
    await r1.processSource(src, "Test");
    const files = fs.readdirSync(path.join(dest, "Artist", "Album"));
    expect(files.filter((f) => f.endsWith(".flac"))).toHaveLength(2);
  });

  test("arquivo parcialmente diferente no mesmo álbum é ADICIONADO, não sobrescreve", async () => {
    makeTorrentRelease(src, "Artist", "Album", 2);
    await new MusicOrganizer(dest).processSource(src, "Test");

    makeTorrentRelease(src, "Artist", "Album", 2);
    // 2ª vinda tem uma faixa extra com conteúdo diferente mesmo nome? não deve sobrescrever
    const s = path.join(src, "Artist", "Album", "01 - faixa.flac");
    fs.writeFileSync(s, "OUTRO-CONTEUDO");
    await new MusicOrganizer(dest).processSource(src, "Test");

    const destFile = path.join(dest, "Artist", "Album", "01 - faixa.flac");
    expect(fs.readFileSync(destFile, "utf8")).not.toBe("OUTRO-CONTEUDO");
  });

  test("águas fuzzy: mesmo álbum com tag diferente na 2ª vinda vai pra MESMA pasta", async () => {
    makeTorrentRelease(src, "Nirvana", "Nevermind", 1);
    await new MusicOrganizer(dest).processSource(src, "Test");

    // 2ª vinda: mesma faixa com outro nome de arquivo (não é duplicado byte-a-byte)
    const extra = path.join(src, "Nirvana", "Nevermind [Remastered]", "01 - faixa (remaster).flac");
    touch(extra, "conteudo-remaster");
    await new MusicOrganizer(dest).processSource(src, "Test");

    const artistDir = path.join(dest, "Nirvana");
    const albums = fs.readdirSync(artistDir).filter((d) => fs.statSync(path.join(artistDir, d)).isDirectory());
    // Deve ter mergeado em 1 pasta (dedup fuzzy), não criado 2 álbuns duplicados
    expect(albums).toHaveLength(1);
    expect(fs.readdirSync(path.join(artistDir, albums[0])).filter((f) => f.endsWith(".flac"))).toHaveLength(2);
  });

  test("faixa avulsa SOLTA na raiz da fonte (streamrip sem add_singles_to_folder) — destino esperado", async () => {
    // BUG DOCUMENTADO: musicOrganizer só processa DIRETÓRIOS; arquivo solto é ignorado
    touch(path.join(src, "01 - Single Song.flac"));
    await new MusicOrganizer(dest).processSource(src, "TideCaller");
    // Comportamento atual: arquivo fica para sempre na fonte, nunca vai pra biblioteca.
    // O teste DOCUMENTA o bug — se passar, o bug foi corrigido.
    const anyAudio = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.endsWith(".flac")) anyAudio.push(full);
      }
    };
    if (fs.existsSync(dest)) walk(dest);
    expect(anyAudio.length).toBe(1); // FALHA = bug confirmado
  });
});
