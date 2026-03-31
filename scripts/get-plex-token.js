/**
 * get-plex-token.js
 *
 * Lê o PlexOnlineToken do Preferences.xml do container Plex e salva no .env.
 * Uso: node scripts/get-plex-token.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PREFS_PATH = path.join(
  ROOT,
  "config",
  "Library",
  "Application Support",
  "Plex Media Server",
  "Preferences.xml"
);

const ENV_PATH = path.join(ROOT, ".env");

// ── Ler token ────────────────────────────────────────────────────────────────
if (!fs.existsSync(PREFS_PATH)) {
  console.error(`❌ Preferences.xml não encontrado em:\n   ${PREFS_PATH}`);
  console.error("   Verifique se o container Plex já foi iniciado ao menos uma vez.");
  process.exit(1);
}

const xml = fs.readFileSync(PREFS_PATH, "utf8");
const match = xml.match(/PlexOnlineToken="([^"]+)"/);

if (!match) {
  console.error("❌ PlexOnlineToken não encontrado no Preferences.xml.");
  console.error("   Certifique-se de que o Plex está autenticado (conta Plex vinculada).");
  process.exit(1);
}

const token = match[1];
console.log(`✅ Token encontrado: ${token.slice(0, 6)}${"*".repeat(token.length - 6)}`);

// ── Atualizar .env ───────────────────────────────────────────────────────────
let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";

if (/^PLEX_TOKEN=/m.test(envContent)) {
  // Substituir linha existente
  envContent = envContent.replace(/^PLEX_TOKEN=.*$/m, `PLEX_TOKEN=${token}`);
  console.log("📝 PLEX_TOKEN atualizado no .env");
} else {
  // Adicionar após PLEX_CLAIM ou no topo
  if (/^PLEX_CLAIM=/m.test(envContent)) {
    envContent = envContent.replace(
      /^(PLEX_CLAIM=.*)/m,
      `$1\nPLEX_TOKEN=${token}`
    );
  } else {
    envContent = `PLEX_TOKEN=${token}\n` + envContent;
  }
  console.log("📝 PLEX_TOKEN adicionado ao .env");
}

fs.writeFileSync(ENV_PATH, envContent, "utf8");
console.log(`\n✅ Pronto! Execute o servidor novamente para usar o token.\n`);
