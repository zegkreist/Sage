#!/usr/bin/env node
/**
 * test-jackett.js — Teste interno de diagnóstico do Jackett.
 *
 * Reproduz a busca que o Sage faz (Stormbringer → torrentSearch.js:
 * GET /api/v2.0/indexers/all/results) e, principalmente, cronometra CADA indexer
 * individualmente para identificar qual está lento/pendurado/quebrado — que é a
 * causa do timeout de 55s na busca de torrents do Sage.
 *
 * A lista de indexers é obtida via Torznab (t=indexers), que funciona só com a
 * API Key — sem precisar da senha de admin do dashboard.
 *
 * Uso:
 *   node scripts/test-jackett.js [query] [--url URL] [--key APIKEY] [--cat music|movie|series] [--agg]
 *
 *   --agg   também executa a busca agregada "all" (lenta; só para comprovar o timeout)
 *
 * A API Key é resolvida nesta ordem: --key  →  env JACKETT_API_KEY  →  ServerConfig.json
 *
 * Exemplos:
 *   JACKETT_API_KEY=xxxx node scripts/test-jackett.js "Radiohead"
 *   node scripts/test-jackett.js "Pink Floyd" --key xxxx --cat music --agg
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argparse simples ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { query: null, url: null, key: null, cat: "music", agg: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--url") opts.url = argv[++i];
  else if (a === "--key") opts.key = argv[++i];
  else if (a === "--cat") opts.cat = argv[++i];
  else if (a === "--agg") opts.agg = true;
  else if (!a.startsWith("--") && !opts.query) opts.query = a;
}

const CAT = { movie: "2000", series: "5000", music: "3000" };

const JACKETT_URL = (opts.url || process.env.JACKETT_URL || "http://192.168.15.14:9117").replace(/\/$/, "");
const QUERY       = opts.query || "Radiohead";
const CATEGORY    = CAT[opts.cat] || "3000";

const AGG_TIMEOUT_MS = 60_000; // > 55s do Sage, para comprovar o estouro
const PER_TIMEOUT_MS = 20_000; // por-indexer: curto, só para flagrar quem trava
const SLOW_MS        = 10_000; // acima disso = 🐌 LENTO

// ── Resolve API Key ──────────────────────────────────────────────────────────
function readApiKeyFromDisk() {
  const candidates = [
    process.env.JACKETT_CONFIG && path.join(process.env.JACKETT_CONFIG, "Jackett/ServerConfig.json"),
    "/jackett-config/Jackett/ServerConfig.json",
    "/media/ZimaOS-HD/AppData/flaresolverr/config/Jackett/ServerConfig.json",
    "/media/firstBlood/sage/jackett-config/Jackett/ServerConfig.json",
    path.join(__dirname, "../jackett/config/Jackett/ServerConfig.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const key = cfg.APIKey || cfg.ApiKey || cfg.apiKey || cfg.api_key;
      if (key) { console.log(`🔑 API Key lida de: ${p}`); return key; }
    } catch { /* próximo candidato */ }
  }
  return null;
}

const API_KEY = opts.key || process.env.JACKETT_API_KEY || readApiKeyFromDisk();

// ── HTTP com timeout via AbortController ─────────────────────────────────────
async function timedGet(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const elapsed = Date.now() - start;
    const body = await res.text();
    return { ok: res.ok, status: res.status, elapsed, body };
  } catch (e) {
    const elapsed = Date.now() - start;
    const reason = e.name === "AbortError" ? `TIMEOUT>${(timeoutMs / 1000)}s` : (e.cause?.code || e.message);
    return { ok: false, status: 0, elapsed, error: reason };
  } finally {
    clearTimeout(t);
  }
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;
const countItems = (xml) => (xml ? (xml.match(/<item>/g) || []).length : 0);

// Extrai [{id, title}] do XML do Torznab t=indexers (apenas configured="true")
function parseIndexers(xml) {
  const out = [];
  const re = /<indexer\s+id="([^"]+)"\s+configured="([^"]+)"\s*>([\s\S]*?)<\/indexer>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] !== "true") continue;
    const title = (m[3].match(/<title>([^<]*)<\/title>/) || [])[1] || m[1];
    out.push({ id: m[1], title });
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Teste interno do Jackett");
  console.log(`  URL:      ${JACKETT_URL}`);
  console.log(`  Query:    "${QUERY}"  (categoria ${opts.cat} = ${CATEGORY})`);
  console.log(`  API Key:  ${API_KEY ? "(definida)" : "❌ NÃO ENCONTRADA"}`);
  console.log("══════════════════════════════════════════════════════════════\n");

  // 0) Conectividade básica
  console.log("▶ [0] Conectividade básica…");
  const root = await timedGet(`${JACKETT_URL}/`, 8000);
  if (root.status === 0) {
    console.log(`  ❌ Jackett INACESSÍVEL em ${JACKETT_URL} — ${root.error}`);
    console.log("     → host/porta errados, container Jackett parado, ou bloqueio de rede.");
    process.exit(1);
  }
  console.log(`  ✅ Jackett respondeu (HTTP ${root.status} em ${fmt(root.elapsed)})\n`);

  if (!API_KEY) {
    console.log("❌ Sem API Key não dá para consultar os indexers.");
    console.log("   Passe --key <chave>, defina JACKETT_API_KEY, ou aponte JACKETT_CONFIG.");
    console.log("   (A API Key aparece no topo do dashboard do Jackett em :9117.)");
    process.exit(1);
  }

  const apikey = encodeURIComponent(API_KEY);
  const q = encodeURIComponent(QUERY);

  // 1) Enumera indexers configurados (via Torznab — só precisa da API Key)
  console.log("▶ [1] Listando indexers configurados…");
  const list = await timedGet(
    `${JACKETT_URL}/api/v2.0/indexers/all/results/torznab/api?apikey=${apikey}&t=indexers&configured=true`,
    20_000,
  );
  if (list.status === 401) { console.log("  ❌ HTTP 401 — API Key inválida."); process.exit(1); }
  const indexers = list.ok ? parseIndexers(list.body) : [];
  if (!indexers.length) {
    console.log(`  ⚠️  Não consegui enumerar indexers (HTTP ${list.status}). ${list.error || ""}`);
  } else {
    console.log(`  ✅ ${indexers.length} indexers configurados.\n`);
  }

  // 2) Timing por indexer — o diagnóstico principal
  const rows = [];
  if (indexers.length) {
    console.log(`▶ [2] Cronometrando cada indexer (timeout ${fmt(PER_TIMEOUT_MS)} cada)…\n`);
    console.log(`    ${"STATUS".padEnd(15)}${"INDEXER".padEnd(26)}${"TEMPO".padStart(7)}  RESULTADOS`);
    for (const ix of indexers) {
      const r = await timedGet(
        `${JACKETT_URL}/api/v2.0/indexers/${encodeURIComponent(ix.id)}/results/torznab/api?apikey=${apikey}&t=search&q=${q}&cat=${CATEGORY}`,
        PER_TIMEOUT_MS,
      );
      const n = countItems(r.body);
      let tag;
      if (r.status === 0 && String(r.error).startsWith("TIMEOUT")) tag = "⏱️  PENDURADO";
      else if (!r.ok)                    tag = `❌ HTTP ${r.status}`;
      else if (r.elapsed > SLOW_MS)      tag = "🐌 LENTO";
      else                               tag = "✅";
      rows.push({ ...ix, elapsed: r.elapsed, n, tag });
      console.log(`    ${tag.padEnd(15)}${ix.id.padEnd(26)}${fmt(r.elapsed).padStart(7)}  n=${n}`);
    }
  }

  // 3) Busca agregada "all" — igual ao Sage (opcional, lenta)
  if (opts.agg) {
    console.log(`\n▶ [3] Busca AGREGADA /indexers/all/results (igual ao Sage; timeout ${fmt(AGG_TIMEOUT_MS)})…`);
    const agg = await timedGet(
      `${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${apikey}&Query=${q}&Category=${CATEGORY}`,
      AGG_TIMEOUT_MS,
    );
    if (agg.status === 0 && String(agg.error).startsWith("TIMEOUT")) {
      console.log(`  ⏱️  NÃO retornou em ${fmt(AGG_TIMEOUT_MS)} → confirma o timeout de 55s do Sage.`);
    } else if (agg.ok) {
      const total = (() => { try { return (JSON.parse(agg.body).Results || []).length; } catch { return "?"; } })();
      const mark = agg.elapsed > 55_000 ? "⚠️  acima de 55s (Sage daria timeout)" : "✅ dentro de 55s";
      console.log(`  ${mark} — ${fmt(agg.elapsed)}, ${total} resultados.`);
    } else {
      console.log(`  ❌ HTTP ${agg.status} em ${fmt(agg.elapsed)}.`);
    }
  }

  // 4) Resumo / veredito
  const bad  = rows.filter(r => r.tag.includes("PENDURADO") || r.tag.includes("LENTO"));
  const err  = rows.filter(r => r.tag.startsWith("❌"));
  const good = rows.filter(r => r.tag === "✅" && r.n > 0);
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`RESUMO: ${good.length} úteis (com resultados)  |  ${bad.length} lentos/pendurados  |  ${err.length} com erro`);

  if (bad.length) {
    console.log("\n🔎 Culpados pelo timeout (lentos/pendurados) — ordenados pelo mais lento:");
    bad.sort((a, b) => b.elapsed - a.elapsed).forEach(r =>
      console.log(`   • ${r.id.padEnd(26)} ${fmt(r.elapsed).padStart(7)}  ${r.tag}`));
  }
  if (err.length) {
    console.log("\n⚠️  Indexers com erro (rápidos, mas nunca retornam resultado):");
    console.log("   " + err.map(r => r.id).join(", "));
  }
  if (good.length) {
    console.log("\n✅ Indexers saudáveis (manter):");
    good.sort((a, b) => b.n - a.n).forEach(r =>
      console.log(`   • ${r.id.padEnd(26)} n=${r.n}`));
  }

  if (bad.length || err.length) {
    console.log("\n💡 Ação no dashboard do Jackett (:9117):");
    console.log("   1. Desative/remova os indexers lentos/pendurados acima — cada um adia a resposta");
    console.log("      de /indexers/all/results, que é o que o Sage consulta (por isso estoura os 55s).");
    console.log("   2. Os de erro provavelmente precisam de FlareSolverr (Cloudflare) ou estão mortos:");
    console.log("      confira em Jackett → Settings se a URL do FlareSolverr está correta e no ar.");
  }
  console.log("");
})();
