/**
 * FEATURE: montagem de caminhos destino — normalização de artist/album/track,
 * caracteres invasivos e colisões de nome.
 * Usa o mesmo MusicOrganizer do fluxo real (run.js --music).
 */
import fs from "fs";
import path from "path";
import { beforeEach, afterEach, describe, expect, test } from "@jest/globals";
import { MusicOrganizer } from "../../agents/Transporter/src/musicOrganizer.js";
import { sanitizeName, cleanAlbumName } from "../../agents/Transporter/src/strings.js";
import { parseAlbumFolderName } from "../../agents/Transporter/src/audio.js";
import { makeTmp, touch, rmRf, makeStreamripRelease, makeTorrentRelease } from "./helpers.js";

let src, dest, mo;
beforeEach(() => {
  src = makeTmp("path-src-");
  dest = makeTmp("path-dest-");
  mo = new MusicOrganizer(dest, { verbose: false });
});
afterEach(() => {
  rmRf(src);
  rmRf(dest);
});

describe("sanitização de nomes de pasta", () => {
  test("remove caracteres invasivos de Windows/FAT", () => {
    expect(sanitizeName('AC/DC: Back In Black?*')).toBe("ACDC Back In Black");
  });

  test("colapsa espaços múltiplos", () => {
    expect(sanitizeName("Björk   —   Debut")).toBe("Björk — Debut");
  });

  test("parse de pasta streamrip: Artist - Album (Year) [quality]", () => {
    const info = parseAlbumFolderName("Radiohead - OK Computer (1997) [FLAC]");
    expect(info).toEqual({ artist: "Radiohead", year: "1997", album: "OK Computer" });
  });

  test("parse de pasta torrent: Artist - Year - Album", () => {
    expect(parseAlbumFolderName("Judas Priest - 2001 - Demolition"))
      .toEqual({ artist: "Judas Priest", year: "2001", album: "Demolition" });
  });

  test("cleanAlbumName remove tags de qualidade e remaster", () => {
    expect(cleanAlbumName("Tool - Lateralus [24bit Hi-Res Web]".split(" - ")[1] + " [24bit Hi-Res Web]"))
      .toBe("Lateralus");
    expect(cleanAlbumName("Nevermind (Remastered 2021)")).toBe("Nevermind");
  });

  test("caractere de path traversal no nome do artista não escapa do destDir", () => {
    // sanitizeName remove "/" — o destino tem que ficar DENTRO de dest
    const evil = "../../etc";
    const clean = sanitizeName(evil);
    const resolved = path.resolve(dest, clean);
    expect(resolved.startsWith(path.resolve(dest))).toBe(true);
  });
});

describe("MusicOrganizer — estrutura de destino real (streamrip/TideCaller)", () => {
  test("release streamrip vira music/Artist/Album (Year)/", async () => {
    makeStreamripRelease(src, "Bjork", "Debut", "1993");
    await mo.processSource(src, "TideCaller");
    const albumDir = path.join(dest, "Bjork", "Debut (1993)");
    expect(fs.existsSync(albumDir)).toBe(true);
    expect(fs.readdirSync(albumDir).filter((f) => f.endsWith(".flac"))).toHaveLength(2);
  });

  test("release torrent Artist/Album vira music/Artist/Album/", async () => {
    makeTorrentRelease(src, "Pink Floyd", "The Wall");
    await mo.processSource(src, "Stormbringer");
    expect(fs.existsSync(path.join(dest, "Pink Floyd", "The Wall"))).toBe(true);
  });

  test("artista com caracteres invasivos ('?') não quebra o caminho destino", async () => {
    // streamrip (restrict_characters=false) pode gerar nomes com : ? etc.
    makeTorrentRelease(src, "AC?DC", "Back In Black");
    await mo.processSource(src, "Test");
    // destino deve ser plano e sanitizado
    const artistDirs = fs.readdirSync(dest);
    expect(artistDirs).toEqual(["ACDC"]);
    expect(fs.existsSync(path.join(dest, "ACDC", "Back In Black"))).toBe(true);
  });

  test("colisão de artista: 'blink-182' vs 'Blink 182' devem cair na MESMA pasta de artista", async () => {
    makeTorrentRelease(src, "blink-182", "Enema Of The State", 1);
    makeTorrentRelease(src, "Blink 182", "Enema Of The State (2000)", 1);
    await mo.processSource(src, "Test");
    const artists = fs.readdirSync(dest).filter((d) => fs.statSync(path.join(dest, d)).isDirectory());
    // BUG: artistDir usa sanitizeName (não normalizeForComparison) — nomes que
    // são o mesmo artista viram 2 pastas separadas e a biblioteca se divide.
    expect(artists).toHaveLength(1); // FALHA = bug confirmado
  });

  test("colisão de faixa: merge de releases com mesmo basename NÃO pode perder música", async () => {
    makeTorrentRelease(src, "Artist X", "Greatest Hits", 1);
    await new MusicOrganizer(dest).processSource(src, "Test");

    // 2ª vinda: mesma música com MESMO nome de arquivo mas conteúdo distinto
    // (versão diferente, re-encode etc.)
    makeTorrentRelease(src, "Artist X", "Greatest Hits [FLAC]", 1);
    const dup = path.join(src, "Artist X", "Greatest Hits [FLAC]", "01 - faixa.flac");
    fs.writeFileSync(dup, "VERSAO-DIFERENTE");
    await new MusicOrganizer(dest).processSource(src, "Test");

    // Os dois conteúdos devem existir em algum lugar da pasta do álbum
    const albumDir = path.join(dest, "Artist X", "Greatest Hits");
    const contents = fs.readdirSync(albumDir).map((f) => fs.readFileSync(path.join(albumDir, f), "utf8"));
    expect(contents).toContain("VERSAO-DIFERENTE"); // FALHA = perda silenciosa confirmada
  });
});
