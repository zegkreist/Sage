#!/usr/bin/env node
/**
 * plex-cli.js — Controlador central para os agentes do Plex Server
 *
 * Uso via wrapper (recomendado para comandos interativos):
 *   ./plex                                    → menu interativo (TTY limpo)
 *
 * Uso direto:
 *   node plex-cli.js                          → menu interativo (spawnSync)
 *   node plex-cli.js <comando>                → executa diretamente
 *   node plex-cli.js --help                   → lista comandos
 *   node plex-cli.js --pick <arquivo>         → menu: grava snippet shell e sai (usado por ./plex)
 *
 * Exemplos:
 *   node plex-cli.js music:fix-all-tags
 *   node plex-cli.js series:curate:dry
 *   node plex-cli.js plex:status
 *   node plex-cli.js test:all
 */

import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { buildGroups, parseGroupChoice, parseCommandChoice } from "./plex-cli-menu.js";
import { runCommand, buildExecSnippet } from "./plex-cli-run.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);

// When running via the `./plex` wrapper, this is the path of the temp file
// where we write the shell snippet to execute. The wrapper reads it and runs
// it directly in the shell, giving the child exclusive TTY ownership.
const PICK_FILE = (() => {
  const idx = process.argv.indexOf("--pick");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ─── Cores ANSI ───────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};
const c = (color, str) => `${C[color]}${str}${C.reset}`;
const bold = (str) => `${C.bold}${str}${C.reset}`;

// ─── Definição dos comandos ───────────────────────────────────────────────────
const MUSIC_DIR = path.join(ROOT, "agents", "MusicCurator");
const SERIES_DIR = path.join(ROOT, "agents", "SeriesCurator");
const MOVIE_DIR = path.join(ROOT, "agents", "MovieCurator");
const STORMBRINGER_DIR = path.join(ROOT, "agents", "Stormbringer");
const TIDECALLER_DIR = path.join(ROOT, "agents", "TideCaller");
const TRANSPORTER_DIR = path.join(ROOT, "agents", "Transporter");
const MUSICSAGE_DIR = path.join(ROOT, "agents", "MusicSage");

/**
 * Cada entrada:
 *  id       — chave usada na CLI (ex: "music:fix-all-tags")
 *  label    — texto exibido no menu
 *  group    — agrupamento visual
 *  cwd      — diretório de execução
 *  cmd      — comando principal
 *  args     — argumentos
 *  sudo     — true se precisar de sudo
 */
const COMMANDS = [
  // ── Música ──────────────────────────────────────────────────────────────────
  {
    id: "music:consolidate",
    label: "Consolidar biblioteca de música (normaliza pastas + tags)",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "node",
    args: ["src/full-library-consolidation.js", "music"],
  },
  {
    id: "music:fix-all-tags",
    label: "Corrigir TODAS as tags ALBUM incorretas na biblioteca",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "node",
    args: ["src/fix-all-album-tags.js"],
  },
  {
    id: "music:fix-all-tags:dry",
    label: "Corrigir tags ALBUM — DRY RUN (sem alterações)",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "node",
    args: ["src/fix-all-album-tags.js", "--dry-run"],
  },
  {
    id: "music:fix-tags",
    label: "Corrigir tags apenas dos álbuns curados",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "node",
    args: ["src/fix-curated-tags.js"],
  },
  {
    id: "music:fix-tags:dry",
    label: "Corrigir tags dos álbuns curados — DRY RUN",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "node",
    args: ["src/fix-curated-tags.js", "--dry-run"],
  },
  {
    id: "music:test",
    label: "Rodar testes do MusicCurator",
    group: "🎵  Música",
    cwd: MUSIC_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── Séries ───────────────────────────────────────────────────────────────────
  {
    id: "series:curate",
    label: "Curar biblioteca de séries (renomeia pastas + episódios + tags)",
    group: "📺  Séries",
    cwd: SERIES_DIR,
    cmd: "node",
    args: ["index.js"],
    sudo: true,
  },
  {
    id: "series:curate:dry",
    label: "Curar séries — DRY RUN (sem alterações)",
    group: "📺  Séries",
    cwd: SERIES_DIR,
    cmd: "node",
    args: ["index.js", "--dry-run"],
    sudo: true,
  },
  {
    id: "series:fix-tags",
    label: "Corrigir tags de vídeo dos episódios já curados",
    group: "📺  Séries",
    cwd: SERIES_DIR,
    cmd: "node",
    args: ["src/fix-series-tags.js"],
    sudo: true,
  },
  {
    id: "series:fix-tags:dry",
    label: "Corrigir tags de séries — DRY RUN",
    group: "📺  Séries",
    cwd: SERIES_DIR,
    cmd: "node",
    args: ["src/fix-series-tags.js", "--dry-run"],
    sudo: true,
  },
  {
    id: "series:test",
    label: "Rodar testes do SeriesCurator",
    group: "📺  Séries",
    cwd: SERIES_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── Filmes ────────────────────────────────────────────────────────────────
  {
    id: "movie:curate",
    label: "Curar biblioteca de filmes (renomeia pastas + arquivos para Plex)",
    group: "🎬  Filmes",
    cwd: MOVIE_DIR,
    cmd: "node",
    args: ["index.js"],
  },
  {
    id: "movie:curate:dry",
    label: "Curar filmes — DRY RUN (sem alterações)",
    group: "🎬  Filmes",
    cwd: MOVIE_DIR,
    cmd: "node",
    args: ["index.js", "--dry-run"],
  },
  {
    id: "movie:curate:skip",
    label: "Curar filmes — pular já curados",
    group: "🎬  Filmes",
    cwd: MOVIE_DIR,
    cmd: "node",
    args: ["index.js", "--skip-curated"],
  },
  {
    id: "movie:test",
    label: "Rodar testes do MovieCurator",
    group: "🎬  Filmes",
    cwd: MOVIE_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── Transporter ────────────────────────────────────────────────────────────
  {
    id: "transporter:all",
    label: "Mover TODOS os downloads para a biblioteca do Plex (Tidal + Torrent)",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js"],
  },
  {
    id: "transporter:all:dry",
    label: "Mover todos os downloads — DRY RUN (sem mover arquivos)",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--dry-run"],
  },
  {
    id: "transporter:music",
    label: "Mover música (Tidal) para a biblioteca",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--music"],
  },
  {
    id: "transporter:video",
    label: "Mover filmes e séries (torrent) para a biblioteca",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--video"],
  },
  {
    id: "transporter:video:dry",
    label: "Mover filmes e séries — DRY RUN (sem mover arquivos)",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--video", "--dry-run"],
  },
  {
    id: "transporter:movies",
    label: "Mover filmes (downloads/filmes/ → movies/) com MovieCurator",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--movies"],
  },
  {
    id: "transporter:movies:dry",
    label: "Mover filmes — DRY RUN (sem mover arquivos)",
    group: "🚚  Transporter",
    cwd: TRANSPORTER_DIR,
    cmd: "node",
    args: ["src/run.js", "--movies", "--dry-run"],
  },

  // ── Stormbringer (Torrent) ───────────────────────────────────────────────────
  {
    id: "stormbringer:start",
    label: "Iniciar Stormbringer (daemon de downloads)",
    group: "⚡  Stormbringer",
    cwd: STORMBRINGER_DIR,
    cmd: "node",
    args: ["src/index.js"],
  },
  {
    id: "stormbringer:download",
    label: "Buscar e baixar torrent (busca → seleciona → baixa)",
    group: "⚡  Stormbringer",
    cwd: STORMBRINGER_DIR,
    cmd: "node",
    args: ["src/cli.js", "download"],
  },
  {
    id: "stormbringer:search",
    label: "Buscar torrent (só exibe resultados, sem baixar)",
    group: "⚡  Stormbringer",
    cwd: STORMBRINGER_DIR,
    cmd: "node",
    args: ["src/cli.js", "search"],
  },
  {
    id: "stormbringer:downloads",
    label: "Listar status dos downloads",
    group: "⚡  Stormbringer",
    cwd: STORMBRINGER_DIR,
    cmd: "node",
    args: ["src/downloadManagerCli.js", "status"],
  },
  {
    id: "stormbringer:test",
    label: "Rodar testes do Stormbringer",
    group: "⚡  Stormbringer",
    cwd: STORMBRINGER_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── TideCaller (Tidal) ─────────────────────────────────────────────────────
  {
    id: "tidecaller:setup",
    label: "Setup do TideCaller (venv, streamrip, config)",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
    cmd: "bash",
    args: ["setup/setup.sh", "--no-auth"],
  },
  {
    id: "tidecaller:rip",
    label: "Baixar URL do Tidal (álbum / faixa / playlist) via streamrip",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
    cmd: "bash",
    args: ["scripts/rip.sh", "url", "{TIDAL_URL}"],
    inputs: [{ key: "TIDAL_URL", prompt: "URL do Tidal (álbum / faixa / playlist): " }],
  },
  {
    id: "tidecaller:download-artist",
    label: "Buscar artista e baixar discografia ou álbuns selecionados",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
    cmd: "bash",
    args: ["scripts/download_artist.sh"],
  },
  {
    id: "tidecaller:refresh-token",
    label: "Renovar token Tidal (zera tokens + device auth interativo)",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
     cmd: "bash",
     args: ["scripts/refresh_token.sh", "--force"],
  },
  {
    id: "tidecaller:enrich",
    label: "Enriquecer metadados via MusicBrainz",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
    cmd: "bash",
    args: ["scripts/enrich_metadata.sh"],
  },
  {
    id: "tidecaller:test",
    label: "Rodar testes do TideCaller (BATS + pytest)",
    group: "🌊  TideCaller",
    cwd: TIDECALLER_DIR,
    cmd: "bash",
    args: ["setup/run_tests.sh"],
  },

  // ── MusicSage ────────────────────────────────────────────────────────────────
  {
    id: "musicsage:start",
    label: "Iniciar MusicSage (webserver de recomendação + playlist builder)",
    group: "🧠  MusicSage",
    cwd: MUSICSAGE_DIR,
    cmd: "node",
    args: ["index.js"],
  },
  {
    id: "musicsage:test",
    label: "Rodar testes do MusicSage (unitários + integração)",
    group: "🧠  MusicSage",
    cwd: MUSICSAGE_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── Testes ───────────────────────────────────────────────────────────────────
  {
    id: "test:all",
    label: "Rodar TODOS os testes (todos os agentes)",
    group: "🧪  Testes",
    cwd: ROOT,
    cmd: "bash",
    args: ["-c", `cd "${MUSIC_DIR}" && npm test; cd "${SERIES_DIR}" && npm test; cd "${STORMBRINGER_DIR}" && npm test`],
  },
  {
    id: "test:music",
    label: "Testes MusicCurator (unitários + integração)",
    group: "🧪  Testes",
    cwd: MUSIC_DIR,
    cmd: "npm",
    args: ["test"],
  },
  {
    id: "test:series",
    label: "Testes SeriesCurator (unitários + integração)",
    group: "🧪  Testes",
    cwd: SERIES_DIR,
    cmd: "npm",
    args: ["test"],
  },
  {
    id: "test:stormbringer",
    label: "Testes Stormbringer",
    group: "🧪  Testes",
    cwd: STORMBRINGER_DIR,
    cmd: "npm",
    args: ["test"],
  },

  // ── Plex / Docker ────────────────────────────────────────────────────────────
  {
    id: "plex:status",
    label: "Status dos containers Docker",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "docker",
    args: ["compose", "ps"],
  },
  {
    id: "plex:restart",
    label: "Reiniciar container do Plex",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "docker",
    args: ["compose", "restart", "plex"],
  },
  {
    id: "plex:start",
    label: "Subir todos os containers",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "docker",
    args: ["compose", "up", "-d"],
  },
  {
    id: "plex:stop",
    label: "Parar todos os containers",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "docker",
    args: ["compose", "stop"],
  },
  {
    id: "plex:logs",
    label: "Ver logs do Plex (últimas 50 linhas)",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "docker",
    args: ["compose", "logs", "--tail=50", "-f", "plex"],
  },
  {
    id: "plex:scan",
    label: "Forçar Scan Library no Plex (via API)",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "bash",
    args: [
      "-c",
      // Usa a API local do Plex para disparar um refresh
      `curl -s -o /dev/null -w "HTTP %{http_code}" "http://localhost:32400/library/sections/all/refresh?X-Plex-Token=${process.env.PLEX_TOKEN || ""}" && echo " — Scan disparado"`,
    ],
  },
  {
    id: "plex:get-token",
    label: "Ler token do Plex e salvar no .env",
    group: "🐳  Docker / Plex",
    cwd: ROOT,
    cmd: "node",
    args: ["scripts/get-plex-token.js"],
  },
];

// ─── Resolução de inputs dinâmicos ──────────────────────────────────────────
async function resolveArgs(command, extraArgs = []) {
  if (!command.inputs || command.inputs.length === 0) return command.args;

  const values = {};
  for (let i = 0; i < command.inputs.length; i++) {
    const input = command.inputs[i];
    if (extraArgs[i] !== undefined) {
      values[input.key] = extraArgs[i];
    } else {
      const val = await prompt(c("cyan", `  → ${input.prompt}`));
      values[input.key] = val.trim();
    }
  }

  return command.args.map((arg) => arg.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ""));
}

// ─── Execução de um comando ───────────────────────────────────────────────────
// Delegates to runCommand (plex-cli-run.js) which uses spawnSync so the parent
// event loop is fully suspended while the child runs. This gives interactive
// children (inquirer, bash menus, fzf, …) exclusive access to the terminal.
function run(command, resolvedArgs) {
  return runCommand(command, resolvedArgs);
}

// ─── Header ──────────────────────────────────────────────────────────────────
function printHeader() {
  console.clear();
  console.log();
  console.log(bold(c("cyan", "  ██████╗ ██╗     ███████╗██╗  ██╗     ██████╗██╗     ██╗")));
  console.log(bold(c("cyan", "  ██╔══██╗██║     ██╔════╝╚██╗██╔╝    ██╔════╝██║     ██║")));
  console.log(bold(c("cyan", "  ██████╔╝██║     █████╗   ╚███╔╝     ██║     ██║     ██║")));
  console.log(bold(c("cyan", "  ██╔═══╝ ██║     ██╔══╝   ██╔██╗     ██║     ██║     ██║")));
  console.log(bold(c("cyan", "  ██║     ███████╗███████╗██╔╝ ██╗    ╚██████╗███████╗██║")));
  console.log(bold(c("cyan", "  ╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝     ╚═════╝╚══════╝╚═╝")));
  console.log();
  console.log(c("dim", `  Raiz: ${ROOT}`));
  console.log();
}

// ─── Listagem de help ─────────────────────────────────────────────────────────
function printHelp() {
  printHeader();
  console.log(bold("  Uso:") + "  node plex-cli.js [comando]\n");

  let currentGroup = null;
  for (const cmd of COMMANDS) {
    if (cmd.group !== currentGroup) {
      currentGroup = cmd.group;
      console.log(`\n  ${bold(cmd.group)}`);
    }
    const id = c("yellow", cmd.id.padEnd(28));
    const label = c("dim", cmd.label);
    const sudo = cmd.sudo ? c("red", " (sudo)") : "";
    console.log(`    ${id} ${label}${sudo}`);
  }
  console.log();
}

// ─── Menu interativo (dois níveis) ───────────────────────────────────────────
async function interactiveMenu() {
  const groups = buildGroups(COMMANDS);

  // Nível 1 — seleciona o componente
  while (true) {
    printHeader();
    console.log(c("dim", "  Escolha o componente:"));
    console.log();

    groups.forEach((g, i) => {
      const num = c("dim", String(i + 1).padStart(3));
      console.log(`  ${num}  ${bold(g.name)}  ${c("dim", `(${g.items.length} ações)`)}`);
    });

    console.log();
    console.log(c("dim", "  0 = sair"));
    console.log();

    const groupAnswer = await prompt(c("cyan", "  → Componente: "));
    const groupResult = parseGroupChoice(groupAnswer, groups);

    if (groupResult.type === "exit") {
      console.log(c("dim", "\n  Até logo!\n"));
      process.exit(0);
    }

    if (groupResult.type === "invalid") {
      console.log(c("red", "\n  Opção inválida."));
      await sleep(800);
      continue;
    }

    // Nível 2 — seleciona a ação dentro do componente
    const { group } = groupResult;
    while (true) {
      printHeader();
      console.log(`  ${bold(group.name)}`);
      console.log();

      group.items.forEach((cmd, i) => {
        const num = c("dim", String(i + 1).padStart(3));
        const id  = c("yellow", cmd.id.padEnd(28));
        const lbl = c("dim", cmd.label);
        const sudo = cmd.sudo ? c("red", " ⚑") : "";
        console.log(`  ${num}  ${id} ${lbl}${sudo}`);
      });

      console.log();
      console.log(c("dim", "  ⚑ = requer sudo   |   0 = voltar"));
      console.log();

      const cmdAnswer = await prompt(c("cyan", "  → Ação: "));
      const cmdResult = parseCommandChoice(cmdAnswer, group.items);

      if (cmdResult.type === "back") break;

      if (cmdResult.type === "invalid") {
        console.log(c("red", "\n  Opção inválida."));
        await sleep(800);
        continue;
      }

      const selected = cmdResult.command;
      console.log(`\n  ${bold("Executando:")} ${c("yellow", selected.label)}\n`);

      const resolvedArgs = await resolveArgs(selected);

      if (PICK_FILE) {
        // --pick mode: write the shell snippet and exit so the ./plex wrapper
        // can run the command with full, clean TTY ownership.
        const snippet = buildExecSnippet(selected, resolvedArgs);
        fs.writeFileSync(PICK_FILE, snippet + "\n", "utf8");
        process.exit(42);
      }

      await run(selected, resolvedArgs);
      await prompt(c("dim", "\n  Pressione ENTER para voltar ao menu..."));
    }
  }
}

// ─── Utilitários ─────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const cliArg = process.argv[2];

if (!cliArg || cliArg === "--help" || cliArg === "-h" || cliArg === "--pick") {
  if (!cliArg || cliArg === "--pick") {
    // Modo interativo (direto ou via ./plex wrapper)
    await interactiveMenu();
  } else {
    printHelp();
  }
} else {
  // Modo direto: node plex-cli.js <id>
  const command = COMMANDS.find((c) => c.id === cliArg);
  if (!command) {
    console.error(c("red", `\nComando desconhecido: "${cliArg}"`));
    console.error(c("dim", `Use --help para ver os comandos disponíveis.\n`));
    process.exit(1);
  }
  console.log(`\n${bold("Plex CLI")} — ${c("yellow", command.label)}`);
  const extraArgs = process.argv.slice(3);
  const resolvedArgs = await resolveArgs(command, extraArgs);
  const code = await run(command, resolvedArgs);
  process.exit(code ?? 0);
}
