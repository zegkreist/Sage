#!/usr/bin/env node
/**
 * Transporter — Orquestrador de mover downloads para a biblioteca do Plex.
 *
 * Responsabilidade:
 *   Lê das pastas de download (TideCaller e Stormbringer), corrige a estrutura
 *   de pastas/nomes e move para a biblioteca do Plex:
 *     - agents/TideCaller/downloads/  → plex_server/music/  (Tidal)
 *     - downloads/musicas/            → plex_server/music/  (torrent)
 *     - downloads/filmes/             → plex_server/movies/ (torrent)
 *     - downloads/series/             → plex_server/tv/     (torrent)
 *
 * Formatos de pasta de música suportados (Stormbringer + TideCaller):
 *   (Artist - Album)/track
 *   (Artist - Year - Album)/track
 *   Artist/Album/track
 *   Artist/Album/CD 1/track
 *   Artist - Album (Year) [quality]/track  (streamrip/Tidal)
 *
 * Uso:
 *   node src/run.js              → move tudo (música + filmes + séries)
 *   node src/run.js --dry-run    → apenas simula, sem mover
 *   node src/run.js --music      → apenas música (Tidal + torrents)
 *   node src/run.js --movies     → apenas filmes (torrents)
 *   node src/run.js --series     → apenas séries (torrents)
 *   node src/run.js --video      → filmes e séries via plexOrganizer.js (legado)
 *   node src/run.js --targets <file|json> → SOMENTE as pastas/itens concluídos
 *       (usado pelo auto-transporter: [{type:"music",path:"/downloads/..."}])
 *       Sem varredura geral — torrents ainda baixando não são tocados.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { MusicOrganizer } from "./musicOrganizer.js";
import { MovieOrganizer } from "./movieOrganizer.js";
import { isReleaseFolder, parseAlbumFolderName } from "./audio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLEX_ROOT = path.resolve(__dirname, "../../..");
const DOWNLOADS_DIR  = process.env.DOWNLOADS_DIR  || "/downloads";
const PLEX_MEDIA_PATH = process.env.PLEX_MEDIA_PATH || "/media";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-d");
const onlyMusic = args.includes("--music");
const onlyVideo = args.includes("--video");
const onlyMovies = args.includes("--movies");
const onlySeries = args.includes("--series");
const verbose = args.includes("--verbose") || args.includes("-v");

/**
 * Modo alvo: --targets '<json>' ou --targets /caminho/manifest.json
 * Processa apenas os itens concluídos (nada de varredura geral da pasta).
 * @returns {Array<{type:string, path:string}>|null}
 */
function parseTargets() {
  const idx = args.indexOf("--targets");
  if (idx === -1) return null;
  const raw = args[idx + 1];
  if (!raw) throw new Error("--targets requer JSON ou caminho de manifest");
  let text = raw;
  if (fs.existsSync(raw)) text = fs.readFileSync(raw, "utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("--targets: esperado array de {type, path}");
  return parsed.filter((t) => t?.path);
}
const targetItems = parseTargets(); // null = modo legado (varredura por pasta)

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

function spawnAsync(cmd, spawnArgs, cwd, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n${C.dim}${"─".repeat(70)}${C.reset}`);
    console.log(`${C.bold}${C.cyan}🚚 Transporter → ${label}${C.reset}`);
    console.log(`${C.dim}${"─".repeat(70)}${C.reset}\n`);
    const child = spawn(cmd, spawnArgs, { cwd, stdio: "inherit" });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${label} saiu com código ${code}`));
      else resolve();
    });
    child.on("error", reject);
  });
}

async function runMusic() {
  console.log(`\n${C.dim}${"─".repeat(70)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}🚚 Transporter → Música (Tidal + Torrent → library)${C.reset}`);
  console.log(`${C.dim}${"─".repeat(70)}${C.reset}`);

  const organizer = new MusicOrganizer(path.join(PLEX_MEDIA_PATH, "music"), { dryRun, verbose });

  // Fonte 1: TideCaller (Tidal — já mais organizado)
  await organizer.processSource(
    path.join(DOWNLOADS_DIR, "tidecaller"),
    "TideCaller"
  );

  // Fonte 2: Stormbringer (torrent — vários formatos de pasta)
  await organizer.processSource(
    path.join(DOWNLOADS_DIR, "stormbringer", "musicas"),
    "Stormbringer"
  );

  organizer.printStats();
}

async function runMovies() {
  console.log(`\n${C.dim}${"─".repeat(70)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}🚚 Transporter → Filmes (Torrent → library)${C.reset}`);
  console.log(`${C.dim}${"─".repeat(70)}${C.reset}`);

  const organizer = new MovieOrganizer(path.join(PLEX_MEDIA_PATH, "movies"), {
    dryRun,
    verbose,
  });

  organizer.processSource(
    path.join(DOWNLOADS_DIR, "stormbringer", "filmes"),
    "Stormbringer"
  );

  organizer.printStats();
}

async function runSeries() {
  const extraArgs = dryRun ? ["--dry-run"] : ["--yes", "--series-only"];
  const stormbringerDir = process.env.STORMBRINGER_DIR || path.join(path.resolve(__dirname, "../../.."), "agents", "Stormbringer");
  await spawnAsync("node", ["src/plexOrganizer.js", ...extraArgs], stormbringerDir, "Séries (Torrent → library)");
}

// Legado: mantido para compatibilidade com chamadas diretas --video
async function runVideo() {
  const extraArgs = dryRun ? ["--dry-run"] : ["--yes"];
  const stormbringerDir = process.env.STORMBRINGER_DIR || path.join(path.resolve(__dirname, "../../.."), "agents", "Stormbringer");
  await spawnAsync("node", ["src/plexOrganizer.js", ...extraArgs], stormbringerDir, "Vídeo — filmes e séries (Torrent → library)");
}

// ── Modo alvo (auto-transporter): processa SOMENTE itens concluídos ────────

/** Processa um item específico (pasta de release/álbum OU arquivo solto). */
async function processTarget(item) {
  const targetPath = path.resolve(item.path);
  const type = item.type || "music";
  if (!fs.existsSync(targetPath)) {
    // FIX: alvo inexistente vira ERRO, não aviso — "já movido?" era uma suposição
    // otimista; um path lixo do chamador (ex: stdout parseado) passava despercebido
    // como no-op e o item nunca chegava à biblioteca. Retornando failure o run.js
    // sai com exit != 0 e o status no musicsage mostra o problema.
    console.error(`❌ Alvo não existe: ${targetPath} (type=${type})`);
    return { ok: false, skipped: true, path: targetPath };
  }
  const st = fs.statSync(targetPath);

  if (type === "music") {
    const organizer = new MusicOrganizer(path.join(PLEX_MEDIA_PATH, "music"), { dryRun, verbose });
    if (st.isFile()) {
      await organizer._moveLooseTrack(targetPath, "Auto");
    } else if (isReleaseFolder(targetPath)) {
      // A própria pasta é a release → mover direto (processSource iteraria
      // os arquivos internos e os trataria como faixas soltas — errado).
      const info = parseAlbumFolderName(path.basename(targetPath));
      await organizer._moveRelease(targetPath, info.artist, info.album, info.year, "Auto");
    } else {
      // Pasta de artista (Artist/Album/...) ou raiz de fonte: mesma lógica
      const label = path.dirname(targetPath).includes("tidecaller") ? "TideCaller" : "Stormbringer";
      await organizer.processSource(targetPath, label);
    }
    organizer.printStats();
    return;
  }

  if (type === "movies") {
    const organizer = new MovieOrganizer(path.join(PLEX_MEDIA_PATH, "movies"), { dryRun, verbose });
    if (st.isFile()) organizer._processVideoFile(targetPath, path.basename(targetPath));
    else organizer._processMovieFolder(targetPath, path.basename(targetPath));
    organizer.printStats();
    return;
  }

  // Séries: sem caminho granular (plexOrganizer faz varredura própria) —
  // cai no fluxo legado, que é seguro pois séries ficam em pasta separada
  // e o guard de atividade (lado do servidor) já evitou concorrência.
  const extraArgs = dryRun ? ["--dry-run"] : ["--yes", "--series-only"];
  const stormbringerDir = process.env.STORMBRINGER_DIR || path.join(path.resolve(__dirname, "../../.."), "agents", "Stormbringer");
  await spawnAsync("node", ["src/plexOrganizer.js", ...extraArgs], stormbringerDir, "Séries (Torrent → library)");
}

async function runTargets() {
  console.log(`\n${C.bold}🎯 Modo alvo — ${targetItems.length} item(ns) concluído(s)${C.reset}\n`);
  let failures = 0;
  for (const item of targetItems) {
    try {
      const res = await processTarget(item);
      if (res && res.ok === false) failures++;
    } catch (err) {
      console.error(`${C.red}✗ Falha ao transportar ${item.path}: ${err.message}${C.reset}`);
      failures++;
    }
  }
  // FIX: sair com erro se algum alvo era inválido — exit 0 mascarava o problema
  // (paths lixo do TideCaller passavam como "transporte bem-sucedido").
  if (failures > 0) {
    console.error(`${C.red}${failures} alvo(s) falharam${C.reset}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`\n${C.bold}🚚 TRANSPORTER — Mover downloads para a biblioteca do Plex${C.reset}\n`);
  if (dryRun) {
    console.log(`${C.yellow}🔍 Modo DRY RUN — nenhum arquivo será movido${C.reset}\n`);
  }

  try {
    if (targetItems) {
      await runTargets();
      console.log(`\n${C.bold}${C.green}✅ Transporter concluído!${C.reset}\n`);
      return;
    }

    const runAll = !onlyMusic && !onlyVideo && !onlyMovies && !onlySeries;
    if (runAll || onlyMusic) await runMusic();
    if (runAll || onlyMovies) await runMovies();
    if (runAll || onlySeries) await runSeries();
    if (onlyVideo) await runVideo(); // legado: --video ainda funciona explicitamente
    console.log(`\n${C.bold}${C.green}✅ Transporter concluído!${C.reset}\n`);
  } catch (err) {
    console.error(`\n${C.red}❌ Erro no Transporter: ${err.message}${C.reset}\n`);
    process.exit(1);
  }
}

main();

