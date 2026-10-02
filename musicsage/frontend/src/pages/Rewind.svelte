<script>
  // ─── F3: Retrospectiva em tela cheia ────────────────────────
  // Filtros period/userId sincronizados com a URL via hash:
  //   #/rewind?period=year&userId=3
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { navigate } from '$lib/stores/router.js';
  import { users, selectedUserId } from '$lib/stores/user.js';

  import Spinner  from '../components/ui/Spinner.svelte';
  import StatCard from '../components/ui/StatCard.svelte';

  const PERIODS = [
    { key: 'week',  label: '7 dias'   },
    { key: 'month', label: '30 dias'  },
    { key: 'year',  label: '12 meses' },
  ];
  const VALID = new Set(['week', 'month', 'year']);

  let period = $state('month');
  let userId = $state(null);   // null = todos os usuários
  let metrics = $state(null);
  let loading = $state(true);

  // ── Leitura/escrita dos filtros na URL ─────────────────────
  function readFiltersFromHash() {
    const h = window.location.hash.slice(1);
    const query = h.includes('?') ? h.split('?')[1] : '';
    const params = new URLSearchParams(query);
    const p = params.get('period');
    const u = params.get('userId');
    if (p && VALID.has(p)) period = p;
    userId = u ? parseInt(u, 10) : null;
  }

  function writeFiltersToHash() {
    const params = new URLSearchParams();
    if (period) params.set('period', period);
    if (userId != null) params.set('userId', String(userId));
    window.location.hash = `/rewind?${params.toString()}`;
  }

  function setPeriod(p) {
    if (period === p) return;
    period = p;
    writeFiltersToHash();
  }

  function setUserId(e) {
    const v = e.target.value;
    userId = v ? parseInt(v, 10) : null;
    selectedUserId.set(userId);
    writeFiltersToHash();
  }

  // ── Dados ───────────────────────────────────────────────────
  async function loadMetrics() {
    loading = true;
    const userParam = userId != null ? `&userId=${userId}` : '';
    try {
      metrics = await api('GET', `/library/metrics?period=${period}${userParam}`);
    } catch (e) { toast.error(`Retrospectiva: ${e.message}`); }
    finally { loading = false; }
  }

  async function loadUsers() {
    try {
      const data = await api('GET', '/library/users');
      users.set(data?.users ?? []);
    } catch { /* silencioso — o seletor simplesmente não aparece */ }
  }

  function fmt(n) {
    if (n == null) return '—';
    return n >= 1_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  onMount(async () => {
    readFiltersFromHash();
    selectedUserId.set(userId);
    const onHash = () => {
      if (!window.location.hash.startsWith('#/rewind')) return;
      readFiltersFromHash(); // o $effect abaixo reage às mudanças de period/userId
    };
    window.addEventListener('hashchange', onHash);
    await Promise.allSettled([loadUsers()]);
    return () => window.removeEventListener('hashchange', onHash);
  });

  // Recarrega na montagem e sempre que os filtros mudam (local ou via URL)
  $effect(() => { void period; void userId; loadMetrics(); });
</script>

<div class="p-6 w-full min-h-full space-y-6 animate-fade-in">

  <!-- ── Header ─────────────────────────────────────────────── -->
  <div class="flex items-end justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-extrabold tracking-tight">
        <span class="text-gradient">Retrospectiva</span>
      </h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Seu resumo de escuta em tela cheia</p>
    </div>
    <div class="flex items-center gap-3 flex-wrap">
      <!-- Seletor de usuário Plex -->
      {#if $users.length > 1}
        <div class="flex items-center gap-2">
          <span class="text-2xs" style="color:#5a5a78">Usuário:</span>
          <select
            value={userId ?? ''}
            onchange={setUserId}
            class="rounded-lg px-3 py-1.5 text-xs border transition-colors focus:outline-none"
            style="background:#111118;border-color:#1e1e2e;color:#e0e0f0"
          >
            <option value="">Todos</option>
            {#each $users as u}
              <option value={u.id}>{u.name}</option>
            {/each}
          </select>
        </div>
      {/if}
      <!-- Filtro de período -->
      <div class="flex gap-1 p-1 rounded-lg" style="background:var(--bg)">
        {#each PERIODS as p}
          <button
            class="px-3 py-1 rounded-md text-2xs font-semibold transition-all"
            style={period === p.key
              ? 'background:rgba(124,106,245,0.18);color:var(--accent-hi);border:1px solid rgba(124,106,245,0.25)'
              : 'color:#5a5a78;border:1px solid transparent'}
            onclick={() => setPeriod(p.key)}
          >{p.label}</button>
        {/each}
      </div>
      <button
        class="text-2xs px-3 py-1.5 rounded-lg transition-colors"
        style="background:var(--surface2);color:#5a5a78;border:1px solid #1e1e2e"
        onclick={() => navigate('dashboard')}
      >← Dashboard</button>
    </div>
  </div>

  <!-- ── Conteúdo ───────────────────────────────────────────── -->
  {#if loading}
    <div class="flex items-center gap-3 py-16 justify-center">
      <Spinner />
      <span class="text-sm" style="color:#5a5a78">Carregando retrospectiva…</span>
    </div>
  {:else if metrics}
    <!-- Summary -->
    {#if metrics.summary}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Reproduções"    value={fmt(metrics.summary.totalPlays ?? 0)}          icon="▶" accent />
        <StatCard label="Horas ouvidas"  value={(metrics.summary.totalHours ?? 0).toFixed(1)}  icon="⏱" />
        <StatCard label="Faixas únicas"  value={fmt(metrics.summary.uniqueTracks ?? 0)}        icon="♪" />
        <StatCard label="Artistas únicos" value={fmt(metrics.summary.uniqueArtists ?? 0)}      icon="◈" />
      </div>
    {/if}

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">

      <!-- Top Artistas -->
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1e1e2e">
        <div class="text-2xs font-semibold uppercase tracking-wider mb-3" style="color:#5a5a78">Top Artistas</div>
        {#each (metrics.topArtists ?? []).slice(0, 10) as a, i}
          <div class="list-row flex items-center gap-3 py-2">
            <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
            {#if a.thumb}
              <img src="/api/library/thumb?path={encodeURIComponent(a.thumb)}" class="w-7 h-7 rounded object-cover shrink-0" alt="" />
            {:else}
              <div class="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs" style="background:#1e1e2e;color:#5a5a78">◈</div>
            {/if}
            <div class="flex-1 min-w-0">
              <div class="text-sm text-white truncate">{a.artist ?? '?'}</div>
              <div class="text-2xs truncate" style="color:#5a5a78">{a.analysisGenre ?? a.genres?.[0] ?? (a.totalMinutes ? a.totalMinutes + ' min' : '')}</div>
            </div>
            <span class="text-2xs stat-value" style="color:#5a5a78">{fmt(a.playCount ?? 0)}</span>
          </div>
        {:else}
          <div class="py-6 text-center text-2xs" style="color:#5a5a78">Sem dados</div>
        {/each}
      </div>

      <!-- Top Faixas -->
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1e1e2e">
        <div class="text-2xs font-semibold uppercase tracking-wider mb-3" style="color:#5a5a78">Top Faixas</div>
        {#each (metrics.topTracks ?? []).slice(0, 10) as t, i}
          <div class="list-row flex items-center gap-3 py-2">
            <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
            {#if t.thumb}
              <img src="/api/library/thumb?path={encodeURIComponent(t.thumb)}" class="w-7 h-7 rounded object-cover shrink-0" alt="" />
            {:else}
              <div class="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs" style="background:#1e1e2e;color:#5a5a78">♪</div>
            {/if}
            <div class="flex-1 min-w-0">
              <div class="text-sm text-white truncate">{t.title ?? '?'}</div>
              {#if t.artist}<div class="text-2xs truncate" style="color:#5a5a78">{t.artist}</div>{/if}
            </div>
            <span class="text-2xs stat-value" style="color:#5a5a78">{fmt(t.playCount ?? 0)}</span>
          </div>
        {:else}
          <div class="py-6 text-center text-2xs" style="color:#5a5a78">Sem dados</div>
        {/each}
      </div>

      <!-- Gêneros -->
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1e1e2e">
        <div class="flex items-center gap-2 mb-3">
          <div class="text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Gêneros</div>
          {#if metrics.topAnalysisGenres?.length}
            <span class="text-2xs px-1.5 py-px rounded" style="background:rgba(29,185,84,0.1);color:#1db954;border:1px solid rgba(29,185,84,0.2)">da análise</span>
          {:else}
            <span class="text-2xs px-1.5 py-px rounded" style="color:var(--muted);border:1px solid #1e1e2e">Plex tags</span>
          {/if}
        </div>
        {#each (metrics.topAnalysisGenres ?? metrics.topGenres ?? []).slice(0, 10) as g, i}
          <div class="list-row flex items-center gap-3 py-2">
            <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
            <span class="text-sm flex-1 truncate text-white">{g.genre ?? g.name ?? '?'}</span>
            <div class="text-right shrink-0">
              <div class="text-2xs stat-value" style="color:#5a5a78">{fmt(g.playCount ?? 0)} plays</div>
              {#if g.trackCount}<div class="text-2xs" style="color:var(--muted)">{g.trackCount} faixas</div>{/if}
            </div>
          </div>
        {:else}
          <div class="py-6 text-center text-2xs" style="color:#5a5a78">Sem dados</div>
        {/each}
      </div>

    </div>
  {:else}
    <div class="py-16 text-center text-sm" style="color:#5a5a78">Nenhum dado para este período/usuário</div>
  {/if}

</div>
