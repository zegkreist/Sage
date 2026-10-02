#!/usr/bin/env node
/**
 * Testes de contrato da API REST do MusicSage (Sage).
 * Sem dependências externas — usa fetch nativo do Node (>= 18).
 *
 * Uso:
 *   node contract-tests.js                    # http://192.168.15.14:3002
 *   BASE_URL=http://localhost:3002 node contract-tests.js
 */

const BASE_URL = (process.env.BASE_URL || 'http://192.168.15.14:3002').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push({ label, extra });
    console.log(`  FAIL  ${label}${extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
}

async function call(method, path, { body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não-JSON */ }
  return { status: res.status, json, text: text.slice(0, 2000) };
}

async function test(name, fn) {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push({ label: name, extra: String(err) });
    console.log(`  FAIL  ${name} — ${err.message || err}`);
  }
}

/* -------------------------------------------------------------------------- */

async function run() {
  console.log(`MusicSage contract tests → ${BASE_URL}\n`);

  await test('GET /api/health', async () => {
    const r = await call('GET', '/api/health');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && r.json.status === 'ok', 'status:"ok"', r.json);
    assert(typeof r.json.service === 'string', 'service é string', r.json);
  });

  await test('GET /api/library/stats', async () => {
    const r = await call('GET', '/api/library/stats');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && Number.isInteger(r.json.totalArtists) && r.json.totalArtists >= 0, 'totalArtists inteiro ≥ 0', r.json && r.json.totalArtists);
    assert(Number.isInteger(r.json.totalAlbums), 'totalAlbums inteiro', r.json && r.json.totalAlbums);
    assert(Number.isInteger(r.json.totalTracks), 'totalTracks inteiro', r.json && r.json.totalTracks);
    assert(Array.isArray(r.json.topGenres), 'topGenres é array', typeof (r.json && r.json.topGenres));
    assert(Number.isInteger(r.json.totalPlaylists), 'totalPlaylists inteiro', r.json && r.json.totalPlaylists);
  });

  await test('GET /api/library/users', async () => {
    const r = await call('GET', '/api/library/users');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && Array.isArray(r.json.users), 'users é array', r.json);
    if (r.json && Array.isArray(r.json.users) && r.json.users.length > 0) {
      const u = r.json.users[0];
      assert('id' in u && 'name' in u, 'usuário tem id e name', u);
    }
  });

  await test('GET /api/playlists', async () => {
    const r = await call('GET', '/api/playlists');
    assert(r.status === 200, 'status 200', r.status);
    assert(Array.isArray(r.json), 'corpo é array de playlists', typeof r.json);
    if (Array.isArray(r.json) && r.json.length > 0) {
      const p = r.json[0];
      assert(typeof p.id === 'string' && typeof p.name === 'string', 'playlist tem id e name', p);
      assert(Array.isArray(p.tracks), 'playlist tem tracks[]', typeof p.tracks);
    }
  });

  await test('GET /api/playlists/:id — válido e 404 para inexistente', async () => {
    const list = await call('GET', '/api/playlists');
    if (Array.isArray(list.json) && list.json.length > 0) {
      const id = list.json[0].id;
      const r = await call('GET', `/api/playlists/${id}`);
      assert(r.status === 200, 'status 200 para id existente', r.status);
      assert(r.json && r.json.id === id, 'id corresponde', r.json && r.json.id);
    } else {
      console.log('  SKIP  sem playlists na base — só valida 404');
    }
    const nf = await call('GET', '/api/playlists/nao-existe-xyz');
    assert(nf.status === 404, 'status 404 para id inexistente', nf.status);
  });

  await test('GET /api/favorites', async () => {
    const r = await call('GET', '/api/favorites');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && Array.isArray(r.json.favorites), 'favorites é array', r.json);
  });

  await test('GET /api/library/metrics', async () => {
    const r = await call('GET', '/api/library/metrics');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && typeof r.json === 'object', 'corpo é objeto JSON');
  });

  await test('GET /api/logs/files', async () => {
    const r = await call('GET', '/api/logs/files');
    assert(r.status === 200, 'status 200', r.status);
    assert(r.json && Array.isArray(r.json.files), 'files é array', r.json);
  });

  await test('Rota inexistente → 404', async () => {
    const r = await call('GET', '/api/definitivamente-nao-existe');
    assert(r.status === 404, 'status 404', r.status);
  });

  console.log('\n' + '='.repeat(50));
  console.log(`Total: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
  if (failures.length) {
    console.log('\nFalhas:');
    for (const f of failures) console.log(` - ${f.label}`);
    process.exit(1);
  }
  console.log('✅ Todos os testes passaram.');
}

run().catch((e) => {
  console.error(`\n❌ Erro fatal: ${e.message}`);
  console.error(`   Não foi possível alcançar ${BASE_URL}`);
  process.exit(2);
});
