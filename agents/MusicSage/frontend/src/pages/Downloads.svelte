<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { fmtBytes } from '$lib/utils.js';
  import { downloadIntent } from '$lib/stores/router.js';

  import Button      from '../components/ui/Button.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';

  // ─── Tabs ────────────────────────────────────────────────
  let activeTab = $state('stormbringer');

  // ─── Active downloads monitor ────────────────────────────
  let sbDownloads  = $state([]);
  let tcDownloads  = $state([]);
  let pollId       = null;

  onMount(() => {
    loadDownloads();
    pollId = setInterval(loadDownloads, 5000);

    // Handle intent from Recommendations page
    const intent = $downloadIntent;
    if (intent) {
      activeTab = intent.tab;
      if (intent.tab === 'stormbringer') sbQuery = intent.artist;
      else if (intent.tab === 'tidecaller') tcArtistQuery = intent.artist;
      downloadIntent.set(null);
    }
  });
  onDestroy(() => clearInterval(pollId));

  async function loadDownloads() {
    try {
      const [sb, tc] = await Promise.allSettled([
        api('GET', '/tools/stormbringer/downloads'),
        api('GET', '/tools/tidecaller/downloads'),
      ]);
      if (sb.status === 'fulfilled') sbDownloads = sb.value?.torrents ?? [];
      if (tc.status === 'fulfilled') tcDownloads = Array.isArray(tc.value) ? tc.value : [];
    } catch { /* non-critical */ }
  }

  // ─── STORMBRINGER ────────────────────────────────────────
  let sbQuery    = $state('');
  let sbType     = $state('music');  // music | movie | series
  let sbResults  = $state([]);
  let sbLoading  = $state(false);
  let sbError    = $state('');

  async function sbSearch() {
    if (!sbQuery.trim()) return;
    sbLoading = true;
    sbError   = '';
    sbResults = [];
    try {
      const pathMap = { music: '/tools/stormbringer/search', movie: '/tools/stormbringer/search/movie', series: '/tools/stormbringer/search/series' };
      sbResults = await api('POST', pathMap[sbType] ?? pathMap.music, { query: sbQuery.trim() });
      if (!Array.isArray(sbResults)) sbResults = sbResults?.results ?? [];
    } catch (e) { sbError = e.message; }
    finally { sbLoading = false; }
  }

  async function sbDownload(torrent) {
    try {
      await api('POST', '/tools/stormbringer/download', { magnet: torrent.magnet ?? torrent.link ?? torrent });
      toast.success(`Download iniciado: ${torrent.title ?? torrent.name}`);
      await loadDownloads();
    } catch (e) { toast.error(e.message); }
  }

  async function sbRemove(infoHash, deleteFiles = false) {
    try {
      await api('DELETE', `/tools/stormbringer/download/${infoHash}?deleteFiles=${deleteFiles}`);
      toast('Torrent removido');
      await loadDownloads();
    } catch (e) { toast.error(e.message); }
  }

  // ─── TIDECALLER ──────────────────────────────────────────
  let tcTokenValid   = $state(null);   // null=unknown, true, false
  let tcOauthUrl     = $state('');
  let tcOauthCode    = $state('');
  let tcOauthSession = $state('');
  let tcOauthStatus  = $state('');     // pending | done | error | timeout
  let tcAuthLoading  = $state(false);
  let tcCheckLoading = $state(true);

  let tcArtistQuery  = $state('');
  let tcArtists      = $state([]);
  let tcArtistLoading = $state(false);
  let tcAlbums       = $state([]);
  let tcSelectedArtist = $state(null);
  let tcAlbumLoading = $state(false);
  let tcSelectedAlbums = $state(new Set());
  let tcDownloading  = $state(false);

  onMount(checkTcToken);

  async function checkTcToken() {
    tcCheckLoading = true;
    try {
      const r = await api('GET', '/tools/tidecaller/token/check');
      tcTokenValid = r.valid;
    } catch { tcTokenValid = false; }
    finally { tcCheckLoading = false; }
  }

  async function startOauth(force = false) {
    tcAuthLoading = true;
    tcOauthUrl   = '';
    tcOauthCode  = '';
    tcOauthStatus = 'pending';
    try {
      const r = await api('POST', '/tools/tidecaller/token/start-oauth', { force });
      tcOauthSession = r.sessionId ?? '';
      tcOauthUrl     = r.url       ?? '';
      tcOauthCode    = r.userCode  ?? '';
      if (r.status === 'done') { tcTokenValid = true; tcOauthStatus = 'done'; }
      else pollOauthStatus();
    } catch (e) { toast.error(e.message); tcOauthStatus = 'error'; }
    finally { tcAuthLoading = false; }
  }

  async function pollOauthStatus() {
    if (!tcOauthSession) return;
    const intv = setInterval(async () => {
      try {
        const r = await api('GET', `/tools/tidecaller/token/status/${tcOauthSession}`);
        tcOauthStatus = r.status;
        if (r.status === 'done') { tcTokenValid = true; clearInterval(intv); }
        else if (r.status === 'error') { clearInterval(intv); toast.error('Autenticação falhou'); }
      } catch { clearInterval(intv); }
    }, 3000);
  }

  async function tcSearchArtists() {
    if (!tcArtistQuery.trim()) return;
    tcArtistLoading = true;
    tcArtists = []; tcAlbums = []; tcSelectedArtist = null;
    try {
      tcArtists = await api('GET', `/tools/tidecaller/artist/search?q=${encodeURIComponent(tcArtistQuery)}`);
    } catch (e) { toast.error(e.message); }
    finally { tcArtistLoading = false; }
  }

  async function tcLoadAlbums(artist) {
    tcSelectedArtist = artist;
    tcAlbums = []; tcSelectedAlbums = new Set();
    tcAlbumLoading = true;
    try {
      tcAlbums = await api('GET', `/tools/tidecaller/artist/${artist.id}/albums`);
    } catch (e) { toast.error(e.message); }
    finally { tcAlbumLoading = false; }
  }

  function tcToggleAlbum(album) {
    const s = new Set(tcSelectedAlbums);
    s.has(album.id) ? s.delete(album.id) : s.add(album.id);
    tcSelectedAlbums = s;
  }

  async function tcDownloadSelected() {
    if (!tcSelectedAlbums.size) { toast.warn('Selecione pelo menos um álbum'); return; }
    tcDownloading = true;
    try {
      const albums = tcAlbums.filter(a => tcSelectedAlbums.has(a.id)).map(a => ({ id: a.id, name: a.title ?? a.name }));
      await api('POST', '/tools/tidecaller/artist/download-albums', { albums });
      toast.success(`${albums.length} álbum(ns) enfileirado(s) para download`);
      tcSelectedAlbums = new Set();
      await loadDownloads();
    } catch (e) { toast.error(e.message); }
    finally { tcDownloading = false; }
  }

  // ─── TRANSPORTER ─────────────────────────────────────────
  let tpType       = $state('music');
  let tpRunning    = $state(false);
  let tpPending    = $state([]);
  let tpError      = $state('');

  onMount(loadPending);

  async function loadPending() {
    try {
      const r = await api('GET', '/tools/transporter/pending');
      // Backend returns [{name, icon, type, count, items:[]}]
      tpPending = Array.isArray(r) ? r : [];
    } catch { tpPending = []; }
  }

  async function runTransporter() {
    tpRunning = true; tpError = '';
    try {
      await api('POST', '/tools/transporter/run', { type: tpType });
      toast.success(`Transporter iniciado — movendo ${tpType}`);
    } catch (e) { tpError = e.message; }
    finally { tpRunning = false; }
  }

  // ─── Status helpers ──────────────────────────────────────
  function torrentPct(t) {
    // DownloadManager stores progress as 0-100 (already multiplied)
    if (t.progress != null) return Math.min(100, Math.round(t.progress));
    if (t.total && t.downloaded) return Math.round((t.downloaded / t.total) * 100);
    return 0;
  }

  function torrentStatusClass(t) {
    const s = (t.status ?? '').toLowerCase();
    if (s.includes('done') || s.includes('seeding') || t.progress >= 100) return 'text-emerald-400';
    if (s.includes('error') || s.includes('fail')) return 'text-red-400';
    return 'text-accent';
  }
</script>

<div class="p-6 w-full min-h-full animate-fade-in space-y-5">

  <!-- Header -->
  <div>
    <h1 class="text-2xl font-extrabold text-white tracking-tight">Downloads</h1>
    <p class="text-sm mt-0.5" style="color:#5a5a78">Stormbringer · TideCaller · Transporter</p>
  </div>

  <!-- Active downloads widget -->
  {#if sbDownloads.length > 0 || tcDownloads.length > 0}
    <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1e1e2e">
      <div class="text-2xs font-semibold uppercase tracking-wider mb-3" style="color:#5a5a78">Downloads Ativos</div>
      <div class="space-y-2.5">
        {#each sbDownloads.slice(0,5) as t}
          <div class="flex items-center gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-xs text-white truncate">{t.name ?? t.title}</div>
              <div class="progress-bar mt-1.5">
                <div class="progress-fill" style="width:{torrentPct(t)}%"></div>
              </div>
            </div>
            <span class="text-2xs stat-value shrink-0 {torrentPct(t) >= 100 ? '' : ''}"
                  style="color:{torrentPct(t) >= 100 ? '#1db954' : '#9d8eff'}">{torrentPct(t)}%</span>
            {#if t.downloadSpeed}
              <span class="text-2xs shrink-0" style="color:#5a5a78">{fmtBytes(t.downloadSpeed)}/s</span>
            {/if}
            <Button size="xs" variant="danger" onclick={() => sbRemove(t.infoHash)}>✕</Button>
          </div>
        {/each}
        {#each tcDownloads.filter(j => j.status === 'running').slice(0,3) as j}
          <div class="flex items-center gap-2">
            <Spinner size="xs" />
            <span class="text-xs text-white truncate">Tidal: {j.albums?.length ?? 0} álbuns</span>
            <span class="text-2xs px-1.5 py-px rounded font-medium" style="background:rgba(56,189,248,0.1);color:#38bdf8">Tidal</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Tab switcher -->
  <div class="flex gap-1 p-1 rounded-xl w-fit" style="background:#0a0a0f;border:1px solid #1e1e2e">
    {#each [['stormbringer','↯ Stormbringer'],['tidecaller','∿ TideCaller'],['transporter','↑ Transporter']] as [tab, label]}
      <button
        class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
        style={activeTab === tab
          ? 'background:rgba(124,106,245,0.18);color:#9d8eff;border:1px solid rgba(124,106,245,0.25)'
          : 'color:#5a5a78;border:1px solid transparent'}
        onclick={() => activeTab = tab}
      >{label}</button>
    {/each}
  </div>

  <!-- ── STORMBRINGER ──────────────────────────────────── -->
  {#if activeTab === 'stormbringer'}
    <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
      <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
        <div class="text-sm font-semibold text-white">Stormbringer — Buscar Torrent</div>
      </div>
      <div class="px-5 py-4 space-y-4">
        <!-- Search row -->
        <div class="flex gap-2 flex-wrap">
          <div class="flex gap-1 p-1 rounded-lg" style="background:#0a0a0f">
            {#each [['music','Música'],['movie','Filme'],['series','Série']] as [t, l]}
              <button
                class="px-3 py-1 rounded-md text-2xs font-semibold transition-all"
                style={sbType === t
                  ? 'background:rgba(124,106,245,0.18);color:#9d8eff'
                  : 'color:#5a5a78'}
                onclick={() => sbType = t}
              >{l}</button>
            {/each}
          </div>
          <input
            type="text"
            bind:value={sbQuery}
            placeholder="Buscar torrent…"
            class="flex-1 min-w-48 rounded-lg px-3 py-1.5 text-sm text-white transition-colors
                   placeholder:text-[#5a5a78] focus:outline-none"
            style="background:#16161f;border:1px solid #1e1e2e"
            onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
            onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
            onkeydown={e => e.key === 'Enter' && sbSearch()}
          />
          <Button onclick={sbSearch} loading={sbLoading} size="sm">Buscar</Button>
        </div>

        {#if sbError}
          <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">{sbError}<button class="ml-2 opacity-60 hover:opacity-100" onclick={() => sbError = ''}>✕</button></div>
        {/if}

        {#if sbLoading}
          <div class="flex items-center gap-2 py-4"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Buscando…</span></div>
        {:else if sbResults.length > 0}
          <div class="overflow-x-auto rounded-xl border" style="border-color:#1a1a28">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b" style="border-color:#1a1a28">
                  <th class="text-left py-2.5 px-3 text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Nome</th>
                  <th class="text-left py-2.5 px-3 text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Tamanho</th>
                  <th class="text-left py-2.5 px-3 text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Seeds</th>
                  <th class="py-2.5 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {#each sbResults as r}
                  <tr class="list-row">
                    <td class="py-2.5 px-3 text-white max-w-xs truncate">{r.title ?? r.name ?? '?'}</td>
                    <td class="py-2.5 px-3 whitespace-nowrap text-2xs" style="color:#5a5a78">{r.size ? fmtBytes(r.size) : '?'}</td>
                    <td class="py-2.5 px-3 text-2xs font-semibold" style="color:#1db954">{r.seeders ?? r.seeds ?? '?'}</td>
                    <td class="py-2.5 px-3">
                      <Button size="xs" onclick={() => sbDownload(r)}>↓ Download</Button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if sbQuery}
          <div class="py-6 text-center text-sm" style="color:#5a5a78">Nenhum resultado</div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── TIDECALLER ────────────────────────────────────── -->
  {#if activeTab === 'tidecaller'}
    <div class="space-y-4">

      <!-- Auth status -->
      <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
        <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Autenticação Tidal</div>
        </div>
        <div class="px-5 py-4">
          {#if tcCheckLoading}
            <div class="flex items-center gap-2"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Verificando token…</span></div>
          {:else}
            <div class="flex items-center gap-3 mb-4 flex-wrap">
              {#if tcTokenValid}
                <span class="text-2xs px-2 py-1 rounded font-medium" style="background:rgba(29,185,84,0.12);color:#1db954;border:1px solid rgba(29,185,84,0.2)">Token válido</span>
              {:else}
                <span class="text-2xs px-2 py-1 rounded font-medium" style="background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.2)">Token inválido ou expirado</span>
              {/if}
              <Button size="xs" variant="ghost" onclick={checkTcToken}>↻ Verificar</Button>
              <Button size="xs" onclick={() => startOauth(false)} loading={tcAuthLoading}>Renovar token</Button>
              <Button size="xs" variant="danger" onclick={() => startOauth(true)} loading={tcAuthLoading}>Forçar OAuth</Button>
            </div>

            {#if tcOauthUrl || tcOauthCode}
              <div class="rounded-xl border p-4 space-y-3" style="background:#16161f;border-color:rgba(124,106,245,0.25)">
                <div class="text-sm font-semibold" style="color:#9d8eff">Autorização necessária</div>
                {#if tcOauthUrl}
                  <div class="text-2xs" style="color:#5a5a78">
                    Acesse: <a href={tcOauthUrl} target="_blank" rel="noopener noreferrer"
                       class="underline break-all" style="color:#9d8eff">{tcOauthUrl}</a>
                  </div>
                {/if}
                {#if tcOauthCode}
                  <div class="flex items-center gap-2">
                    <span class="text-2xs" style="color:#5a5a78">Código:</span>
                    <span class="font-mono font-bold text-white text-lg tracking-widest px-3 py-1 rounded"
                          style="background:#1c1c28">{tcOauthCode}</span>
                  </div>
                {/if}
                {#if tcOauthStatus === 'pending'}
                  <div class="flex items-center gap-2"><Spinner size="xs" /><span class="text-2xs" style="color:#5a5a78">Aguardando autorização…</span></div>
                {:else if tcOauthStatus === 'done'}
                  <span class="text-2xs font-medium" style="color:#1db954">Autenticado com sucesso!</span>
                {:else if tcOauthStatus === 'error'}
                  <span class="text-2xs font-medium" style="color:#ef4444">Falha na autenticação</span>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>

      <!-- Artist search + albums -->
      {#if tcTokenValid}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <!-- Artist search -->
          <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
            <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
              <div class="text-sm font-semibold text-white">Buscar Artista</div>
            </div>
            <div class="px-5 py-4">
              <div class="flex gap-2 mb-4">
                <input
                  type="text"
                  bind:value={tcArtistQuery}
                  placeholder="Nome do artista…"
                  class="flex-1 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none
                         placeholder:text-[#5a5a78]"
                  style="background:#16161f;border:1px solid #1e1e2e"
                  onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
                  onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
                  onkeydown={e => e.key === 'Enter' && tcSearchArtists()}
                />
                <Button size="sm" onclick={tcSearchArtists} loading={tcArtistLoading}>Buscar</Button>
              </div>
              {#if tcArtistLoading}
                <div class="flex items-center gap-2"><Spinner size="sm" /></div>
              {:else if tcArtists.length > 0}
                <div class="space-y-0.5">
                  {#each tcArtists as a}
                    <button
                      class="list-row w-full text-left px-2.5 py-2 rounded-lg text-sm transition-all"
                      style={tcSelectedArtist?.id === a.id ? 'background:rgba(124,106,245,0.12);color:#fff' : 'color:#8888a8'}
                      onclick={() => tcLoadAlbums(a)}
                    >{a.name ?? '?'}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <!-- Albums -->
          <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
            <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
              <div class="text-sm font-semibold text-white">{tcSelectedArtist ? `Álbuns — ${tcSelectedArtist.name}` : 'Álbuns'}</div>
            </div>
            <div class="px-5 py-4">
              {#if tcAlbumLoading}
                <div class="flex items-center gap-2"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Carregando…</span></div>
              {:else if tcAlbums.length > 0}
                <div class="space-y-0.5 max-h-52 overflow-y-auto mb-4">
                  {#each tcAlbums as a}
                    <label class="list-row flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer">
                      <input type="checkbox" checked={tcSelectedAlbums.has(a.id)} onchange={() => tcToggleAlbum(a)} class="accent-[#7c6af5]" />
                      <span class="text-sm text-white flex-1 truncate">{a.title ?? a.name ?? '?'}</span>
                      {#if a.year}<span class="text-2xs" style="color:#5a5a78">{a.year}</span>{/if}
                    </label>
                  {/each}
                </div>
                <div class="flex gap-2 items-center flex-wrap">
                  <Button onclick={tcDownloadSelected} loading={tcDownloading} disabled={!tcSelectedAlbums.size} size="sm">
                    ↓ Baixar {tcSelectedAlbums.size > 0 ? `(${tcSelectedAlbums.size})` : 'selecionados'}
                  </Button>
                  <button class="text-2xs underline" style="color:#5a5a78" onclick={() => tcSelectedAlbums = new Set(tcAlbums.map(a => a.id))}>Todos</button>
                  <button class="text-2xs underline" style="color:#5a5a78" onclick={() => tcSelectedAlbums = new Set()}>Nenhum</button>
                </div>
              {:else if tcSelectedArtist}
                <div class="py-6 text-center text-sm" style="color:#5a5a78">Nenhum álbum encontrado</div>
              {:else}
                <div class="py-6 text-center text-sm" style="color:#5a5a78">Selecione um artista</div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── TRANSPORTER ───────────────────────────────────── -->
  {#if activeTab === 'transporter'}
    <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
      <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
        <div class="text-sm font-semibold text-white">Transporter — Mover arquivos para Plex</div>
      </div>
      <div class="px-5 py-4 space-y-4">
        <!-- Media type -->
        <div>
          <div class="text-2xs font-semibold mb-2" style="color:#5a5a78">Tipo de mídia</div>
          <div class="flex gap-2 flex-wrap">
            {#each [['music','Música'],['movies','Filmes'],['series','Séries'],['all','Todos']] as [t, l]}
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all"
                style={tpType === t
                  ? 'background:rgba(124,106,245,0.18);border-color:rgba(124,106,245,0.3);color:#9d8eff'
                  : 'background:#16161f;border-color:#1e1e2e;color:#5a5a78'}
                onclick={() => tpType = t}
              >{l}</button>
            {/each}
          </div>
        </div>

        {#if tpError}
          <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">{tpError}<button class="ml-2 opacity-60" onclick={() => tpError = ''}>✕</button></div>
        {/if}

        <div class="flex gap-2">
          <Button onclick={runTransporter} loading={tpRunning}>↑ Executar Transporter</Button>
          <Button variant="secondary" onclick={loadPending}>↻ Ver Pendentes</Button>
        </div>

        {#if tpPending.length > 0}
          {@const totalFiles = tpPending.reduce((s, src) => s + (src.count ?? 0), 0)}
          <div>
            <div class="text-2xs font-semibold mb-2" style="color:#5a5a78">
              {totalFiles > 0 ? `Arquivos Pendentes (${totalFiles})` : 'Nenhum arquivo pendente'}
            </div>
            {#if totalFiles > 0}
              <div class="max-h-64 overflow-y-auto rounded-xl border" style="border-color:#1a1a28">
                {#each tpPending.filter(s => (s.count ?? 0) > 0) as src}
                  <div class="border-b last:border-0" style="border-color:#1a1a28">
                    <div class="flex items-center gap-2 px-3 py-2">
                      <span class="text-sm">{src.icon ?? '📁'}</span>
                      <span class="text-xs font-medium text-white flex-1">{src.name}</span>
                      <span class="text-2xs px-1.5 py-0.5 rounded font-medium"
                            style="background:rgba(124,106,245,0.1);color:#9d8eff">{src.count}</span>
                    </div>
                    {#each (src.items ?? []) as item}
                      <div class="list-row flex items-center gap-2 pl-8 pr-3 py-1.5 text-xs">
                        <span style="color:#5a5a78">•</span>
                        <span class="text-white truncate flex-1">{item}</span>
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

</div>
