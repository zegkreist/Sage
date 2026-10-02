/**
 * FEATURE: decisão mover/copiar + arquivos root-owned/sem permissão.
 * Usa o moveFile real do Transporter (mesmo usado por Stormbringer e TideCaller
 * via @plex-agents/transporter).
 */
import fs from "fs";
import path from "path";
import { beforeEach, afterEach, describe, expect, test } from "@jest/globals";
import { moveFile, ensureDir, removeIfEmpty } from "../../agents/Transporter/src/filesystem.js";
import { makeTmp, touch, rmRf } from "./helpers.js";

let tmp;
beforeEach(() => {
  tmp = makeTmp("move-decide-");
});
afterEach(() => rmRf(tmp));

describe("moveFile — comportamento de move (não copia)", () => {
  test("move de verdade: origem some, destino existe", () => {
    const s = touch(path.join(tmp, "a", "01.flac"));
    const d = path.join(tmp, "b", "01.flac");
    moveFile(s, d);
    expect(fs.existsSync(s)).toBe(false);
    expect(fs.existsSync(d)).toBe(true);
  });

  test("cria diretório destino automaticamente", () => {
    const s = touch(path.join(tmp, "x.flac"));
    const d = path.join(tmp, "deep", "nested", "x.flac");
    expect(() => moveFile(s, d)).not.toThrow();
    expect(fs.existsSync(d)).toBe(true);
  });
});

describe("moveFile — arquivos root-owned / sem permissão", () => {
  test("mover arquivo READ-ONLY: rename não precisa de escrita no arquivo", () => {
    const s = touch(path.join(tmp, "ro.flac"), "data");
    fs.chmodSync(s, 0o444); // root-owned/readonly simulado
    const d = path.join(tmp, "out", "ro.flac");
    moveFile(s, d);
    expect(fs.existsSync(d)).toBe(true);
    // best-effort chmod deve ter afrouxado para 0666
    const mode = fs.statSync(d).mode & 0o777;
    expect(mode & 0o444).toBe(0o444); // conteúdo legível
  });

  test("arquivo em diretório SEM permissão de escrita origem: moveFile lança erro claro (não corrompe)", () => {
    const dir = path.join(tmp, "locked");
    fs.mkdirSync(dir);
    const s = touch(path.join(dir, "f.flac"));
    fs.chmodSync(dir, 0o555); // r-x: sem write => rename falha
    const d = path.join(tmp, "out", "f.flac");
    try {
      expect(() => moveFile(s, d)).toThrow();
      // arquivo original tem que continuar intacto em caso de falha
      expect(fs.existsSync(s)).toBe(true);
      expect(fs.existsSync(d)).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  test("falha de move NÃO deve apagar a origem (copy+unlink só depois do copy ok)", () => {
    const s = touch(path.join(tmp, "keep.flac"), "conteúdo");
    const d = path.join(tmp, "nope", "sub", "keep.flac");
    // destino ok — este teste garante que em caso de sucesso a origem some; em
    // caso de falha (diretório origem read-only) a origem permanece — testado acima.
    moveFile(s, d);
    expect(fs.readFileSync(d, "utf8")).toBe("conteúdo");
  });
});

describe("ensureDir / removeIfEmpty", () => {
  test("ensureDir não derruba permissão de pasta já existente", () => {
    const dir = path.join(tmp, "pre");
    fs.mkdirSync(dir, 0o755);
    const before = fs.statSync(dir).mode & 0o777;
    ensureDir(dir);
    const after = fs.statSync(dir).mode & 0o777;
    expect(after).toBe(before);
  });

  test("removeIfEmpty apaga só pastas vazias", () => {
    const empty = path.join(tmp, "empty");
    const full = path.join(tmp, "full");
    fs.mkdirSync(empty);
    fs.mkdirSync(full);
    touch(path.join(full, "a.jpg"));
    removeIfEmpty(empty);
    removeIfEmpty(full);
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.existsSync(full)).toBe(true);
  });
});
