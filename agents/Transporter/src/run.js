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
 */

import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { MusicOrganizer } from "./musicOrganizer.js";
import { MovieOrganizer } from "./movieOrganizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLEX_ROOT = path.resolve(__dirname, "../../..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-d");
const onlyMusic = args.includes("--music");
const onlyVideo = args.includes("--video");
const onlyMovies = args.includes("--movies");
const onlySeries = args.includes("--series");
const verbose = args.includes("--verbose") || args.includes("-v");

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

  const organizer = new MusicOrganizer(path.join(PLEX_ROOT, "music"), { dryRun, verbose });

  // Fonte 1: TideCaller (Tidal — já mais organizado)
  await organizer.processSource(
    path.join(PLEX_ROOT, "agents", "TideCaller", "downloads"),
    "TideCaller"
  );

  // Fonte 2: Stormbringer (torrent — vários formatos de pasta)
  await organizer.processSource(
    path.join(PLEX_ROOT, "downloads", "musicas"),
    "Stormbringer"
  );

  organizer.printStats();
}

async function runMovies() {
  console.log(`\n${C.dim}${"─".repeat(70)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}🚚 Transporter → Filmes (Torrent → library)${C.reset}`);
  console.log(`${C.dim}${"─".repeat(70)}${C.reset}`);

  const organizer = new MovieOrganizer(path.join(PLEX_ROOT, "movies"), {
    dryRun,
    verbose,
  });

  organizer.processSource(
    path.join(PLEX_ROOT, "agents", "Stormbringer", "downloads", "filmes"),
    "Stormbringer"
  );

  organizer.printStats();
}

async function runSeries() {
  const extraArgs = dryRun ? ["--dry-run"] : ["--yes", "--series-only"];
  const stormbringerDir = path.join(PLEX_ROOT, "agents", "Stormbringer");
  await spawnAsync("node", ["src/plexOrganizer.js", ...extraArgs], stormbringerDir, "Séries (Torrent → library)");
}

// Legado: mantido para compatibilidade com chamadas diretas --video
async function runVideo() {
  const extraArgs = dryRun ? ["--dry-run"] : ["--yes"];
  const stormbringerDir = path.join(PLEX_ROOT, "agents", "Stormbringer");
  await spawnAsync("node", ["src/plexOrganizer.js", ...extraArgs], stormbringerDir, "Vídeo — filmes e séries (Torrent → library)");
}

async function main() {
  console.log(`\n${C.bold}🚚 TRANSPORTER — Mover downloads para a biblioteca do Plex${C.reset}\n`);
  if (dryRun) {
    console.log(`${C.yellow}🔍 Modo DRY RUN — nenhum arquivo será movido${C.reset}\n`);
  }

  const runAll = !onlyMusic && !onlyVideo && !onlyMovies && !onlySeries;

  try {
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

