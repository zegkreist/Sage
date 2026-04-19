<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { deriveMoodLabel, relTime } from '$lib/utils.js';
  import { users, selectedUserId } from '$lib/stores/user.js';

  import SectionBox  from '../components/layout/SectionBox.svelte';
  import StatCard    from '../components/ui/StatCard.svelte';
  import MoodBar     from '../components/ui/MoodBar.svelte';
  import TrackRow    from '../components/data/TrackRow.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';

  // ─── State ───────────────────────────────────────────────
  let stats       = $state(null);
  let period      = $state('month');  // week | month | year
  let metrics     = $state(null);
  let moodDay     = $state(null);
  let moodMonth   = $state(null);
  let curiosidades = $state([]);
  let history     = $state([]);
  let discoveries = $state([]);

  let loadingStats    = $state(true);
  let loadingMetrics  = $state(false);
  let loadingMood     = $state(true);
  let loadingHistory  = $state(true);
  let loadingDisc     = $state(true);

  const periodLabel = { week: '7 dias', month: '30 dias', year: '12 meses' };

  // ─── Bootstrap ───────────────────────────────────────────
  onMount(async () => {
    await Promise.allSettled([
      loadStats(),
      loadMood(),
      loadHistory(),
      loadDiscoveries(),
      loadUsers(),
    ]);
  });

  async function loadStats() {
    loadingStats = true;
    try { stats = await api('GET', '/library/stats'); }
    catch (e) { toast.error(`Stats: ${e.message}`); }
    finally { loadingStats = false; }
  }

  async function loadUsers() {
    try {
      const data = await api('GET', '/library/users');
      users.set(data?.users ?? []);
    } catch { /* silently ignore if users API unavailable */ }
  }

  async function loadMetrics() {
    loadingMetrics = true;
    const userParam = $selectedUserId ? `&userId=${$selectedUserId}` : '';
    try { metrics = await api('GET', `/library/metrics?period=${period}${userParam}`); }
    catch (e) { toast.error(`Metrics: ${e.message}`); }
    finally { loadingMetrics = false; }
  }

  async function loadMood() {
    loadingMood = true;
    try {
      [moodDay, moodMonth] = await Promise.all([
        api('GET', '/library/mood?period=day'),
        api('GET', '/library/mood?period=month'),
      ]);
    } catch (e) { toast.error(`Mood: ${e.message}`); }
    finally { loadingMood = false; }
  }

  async function loadHistory() {
    loadingHistory = true;
    try {
      const data = await api('GET', '/library/recently-played?limit=25');
      history      = data?.tracks   ?? data ?? [];
      curiosidades = (await api('GET', '/library/curiosidades').catch(() => null))?.facts ?? [];
    } catch (e) { toast.error(`Histórico: ${e.message}`); }
    finally { loadingHistory = false; }
  }

  async function loadDiscoveries() {
    loadingDisc = true;
    try {
      const cache = await api('GET', '/audio/analysis-cache?limit=500');
      // tracks is a dict { ratingKey: {...} } — convert to array
      const tracksArr = Object.values(cache?.tracks ?? {});
      const played = new Set((history ?? []).map(t => t.ratingKey));
      discoveries = tracksArr
        .filter(t => !played.has(t.ratingKey))
        .slice(0, 12)
        .map(t => ({
          ...t,
          energy: t.analysis?.energy ?? null,
        }));
    } catch { /* non-critical */ }
    finally { loadingDisc = false; }
  }

  // ─── Reactivity ──────────────────────────────────────────
  $effect(() => { if (period || $selectedUserId !== undefined) { metrics = null; loadMetrics(); } });

  // ─── Helpers ─────────────────────────────────────────────
  function moodLabel(m) {
    if (!m) return 'Carregando…';
    return deriveMoodLabel(m.avgEnergy, m.avgValence, m.avgDanceability, m.topMood);
  }

  function fmt(n) {
    if (n == null) return '—';
    return n >= 1_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
</script>

<div class="p-6 w-full min-h-full space-y-7 animate-fade-in">

  <!-- ── Header ──────────────────────────────────────────── -->
  <div class="flex items-end justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">
        <span class="text-gradient">Music</span>Sage
      </h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Visão geral da sua biblioteca no Plex</p>
    </div>
    <div class="flex items-center gap-3 flex-wrap">
      <!-- User selector -->
      {#if $users.length > 0}
        <div class="flex items-center gap-2">
          <span class="text-2xs" style="color:#5a5a78">Usuário:</span>
          <select
            value={$selectedUserId}
            onchange={(e) => selectedUserId.set(e.target.value ? parseInt(e.target.value) : null)}
            class="rounded-lg px-3 py-1.5 text-xs text-white border transition-colors focus:outline-none"
            style="background:#111118;border-color:#1e1e2e;color:#e0e0f0"
          >
            <option value="">Todos</option>
            {#each $users as u}
              <option value={u.id}>{u.name}</option>
            {/each}
          </select>
        </div>
      {/if}
      {#if stats}
        <div class="text-2xs text-right hidden sm:block" style="color:#5a5a78">
          <div class="stat-value text-white text-base font-bold">{fmt(stats.totalTracks)}</div>
          <div>faixas na biblioteca</div>
        </div>
      {/if}
    </div>
  </div>

  <!-- ── Hero stats ──────────────────────────────────────── -->
  {#if loadingStats}
    <div class="flex gap-3 items-center h-24"><Spinner /><span class="text-sm" style="color:#5a5a78">Carregando biblioteca…</span></div>
  {:else if stats}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Artistas"  value={fmt(stats.totalArtists)}        icon="◈"  accent />
      <StatCard label="Álbuns"    value={fmt(stats.totalAlbums)}          icon="⬡" />
      <StatCard label="Faixas"    value={fmt(stats.totalTracks)}          icon="♪" />
      <StatCard label="Playlists" value={fmt(stats.totalPlaylists ?? 0)}  icon="≡" />
    </div>
  {/if}

  <!-- ── Curiosidades (prominente) ──────────────────────── -->
  {#if curiosidades.length > 0}
    <section>
      <div class="flex items-center justify-between mb-3">
        <div>
          <h2 class="text-sm font-semibold text-white">Curiosidades</h2>
          <p class="text-2xs mt-0.5" style="color:#5a5a78">Fatos sobre o seu gosto musical</p>
        </div>
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full"
              style="background:rgba(124,106,245,0.12);color:#9d8eff;border:1px solid rgba(124,106,245,0.2)">
          {curiosidades.length} insights
        </span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each curiosidades as fact, i}
          <div
            class="relative rounded-2xl p-4 border transition-all duration-200 cursor-default group overflow-hidden"
            style="background:#111118;border-color:{i < 2 ? 'rgba(124,106,245,0.2)' : '#1e1e2e'}"
          >
            {#if i < 2}
              <!-- Accent glow for first 2 facts -->
              <div class="absolute top-0 right-0 w-24 h-24 rounded-full opacity-40 pointer-events-none"
                   style="background:radial-gradient(circle, rgba(124,106,245,0.15) 0%, transparent 70%);transform:translate(30%,-30%)"></div>
            {/if}
            <div class="text-2xl mb-2 leading-none">{fact.icon ?? '✦'}</div>
            <div class="text-2xs font-semibold mb-1 uppercase tracking-wider" style="color:#5a5a78">{fact.label ?? ''}</div>
            <div class="text-base font-bold leading-tight {i < 2 ? 'text-gradient' : 'text-white'}">
              {fact.value ?? fact.text ?? ''}
            </div>
            {#if fact.sub}
              <div class="text-2xs mt-1.5" style="color:#8888a8">{fact.sub}</div>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- ── Retrospectiva / Insights ────────────────────────── -->
  <SectionBox noPad title="Retrospectiva">
    {#snippet actions()}
      <div class="flex gap-1 p-1 rounded-lg" style="background:#0a0a0f">
        {#each ['week','month','year'] as p}
          <button
            class="px-3 py-1 rounded-md text-2xs font-semibold transition-all"
            style={period === p
              ? 'background:rgba(124,106,245,0.18);color:#9d8eff;border:1px solid rgba(124,106,245,0.25)'
              : 'color:#5a5a78;border:1px solid transparent'}
            onclick={() => period = p}
          >{periodLabel[p]}</button>
        {/each}
      </div>
    {/snippet}

    <div class="px-5 pb-5 pt-1">
      {#if loadingMetrics}
        <div class="flex items-center gap-2 py-8"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Carregando…</span></div>
      {:else if metrics}
        <!-- Summary bar -->
        {#if metrics.summary}
          <div class="flex flex-wrap gap-6 mb-5 px-1 pb-4 border-b" style="border-color:#1e1e2e">
            <div>
              <div class="text-2xs uppercase tracking-wider mb-0.5" style="color:#5a5a78">Reproduções</div>
              <div class="text-base font-bold text-white">{fmt(metrics.summary.totalPlays ?? 0)}</div>
            </div>
            <div>
              <div class="text-2xs uppercase tracking-wider mb-0.5" style="color:#5a5a78">Horas ouvidas</div>
              <div class="text-base font-bold text-white">{(metrics.summary.totalHours ?? 0).toFixed(1)} h</div>
            </div>
            <div>
              <div class="text-2xs uppercase tracking-wider mb-0.5" style="color:#5a5a78">Faixas únicas</div>
              <div class="text-base font-bold text-white">{fmt(metrics.summary.uniqueTracks ?? 0)}</div>
            </div>
            <div>
              <div class="text-2xs uppercase tracking-wider mb-0.5" style="color:#5a5a78">Artistas únicos</div>
              <div class="text-base font-bold text-white">{fmt(metrics.summary.uniqueArtists ?? 0)}</div>
            </div>
          </div>
        {/if}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">

          <!-- Top Artists -->
          <div>
            <div class="text-2xs font-semibold mb-3 uppercase tracking-wider" style="color:#5a5a78">Top Artistas</div>
            {#each (metrics.topArtists ?? []).slice(0,8) as a, i}
              <div class="list-row flex items-center gap-3 py-2">
                <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                {#if a.thumb}
                  <img src="/api/library/thumb?path={encodeURIComponent(a.thumb)}" class="w-7 h-7 rounded object-cover shrink-0" alt="" />
                {:else}
                  <div class="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs" style="background:#1e1e2e;color:#5a5a78">◈</div>
                {/if}
                <span class="text-sm flex-1 truncate text-white">{a.artist ?? a.title ?? a.name ?? '?'}</span>
                <span class="text-2xs stat-value" style="color:#5a5a78">{fmt(a.playCount ?? 0)}</span>
              </div>
            {/each}
          </div>

          <!-- Top Tracks -->
          <div>
            <div class="text-2xs font-semibold mb-3 uppercase tracking-wider" style="color:#5a5a78">Top Faixas</div>
            {#each (metrics.topTracks ?? []).slice(0,8) as t, i}
              <div class="list-row flex items-center gap-3 py-2">
                <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                {#if t.thumb}
                  <img src="/api/library/thumb?path={encodeURIComponent(t.thumb)}" class="w-7 h-7 rounded object-cover shrink-0" alt="" />
                {:else}
                  <div class="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs" style="background:#1e1e2e;color:#5a5a78">♪</div>
                {/if}
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-white truncate">{t.title ?? t.track ?? '?'}</div>
                  {#if t.artist}<div class="text-2xs truncate" style="color:#5a5a78">{t.artist}</div>{/if}
                </div>
                <span class="text-2xs stat-value" style="color:#5a5a78">{fmt(t.playCount ?? 0)}</span>
              </div>
            {/each}
          </div>

          <!-- Top Genres -->
          <div>
            <div class="text-2xs font-semibold mb-3 uppercase tracking-wider" style="color:#5a5a78">Gêneros</div>
            {#each (metrics.topGenres ?? []).slice(0,8) as g, i}
              <div class="list-row flex items-center gap-3 py-2">
                <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                <span class="text-sm flex-1 truncate text-white">{g.genre ?? g.title ?? g.name ?? '?'}</span>
                <div class="text-right shrink-0">
                  <div class="text-2xs stat-value" style="color:#5a5a78">{fmt(g.playCount ?? 0)} plays</div>
                  {#if g.trackCount}<div class="text-2xs" style="color:#3a3a58">{g.trackCount} faixas</div>{/if}
                </div>
              </div>
            {/each}
          </div>

        </div>
      {:else}
        <div class="py-8 text-center text-sm" style="color:#5a5a78">Selecione um período acima</div>
      {/if}
    </div>
  </SectionBox>

  <!-- ── Mood ────────────────────────────────────────────── -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

    <SectionBox title="Mood de Hoje">
      {#if loadingMood}
        <div class="flex items-center gap-2 py-2"><Spinner size="sm" /></div>
      {:else if moodDay}
        <div class="mb-4">
          <div class="text-base font-bold text-white">{moodLabel(moodDay)}</div>
          <div class="text-2xs mt-0.5" style="color:#5a5a78">{moodDay.tracksAnalyzed ?? 0} faixas analisadas hoje</div>
        </div>
        <div class="space-y-3">
          <MoodBar label="Energia"       value={+(moodDay.avgEnergy ?? 0).toFixed(1)} />
          <MoodBar label="Valência"      value={+(moodDay.avgValence ?? 0).toFixed(1)} />
          <MoodBar label="Dançabilidade" value={+(moodDay.avgDanceability ?? 0).toFixed(1)} />
          <MoodBar label="Positividade"  value={+(moodDay.avgLiveness ?? 0).toFixed(1)} />
        </div>
      {:else}
        <div class="py-4 text-center">
          <div class="text-xl mb-1">◈</div>
          <div class="text-sm text-white">Sem dados de hoje</div>
          <div class="text-2xs mt-1" style="color:#5a5a78">Toque músicas no Plex</div>
        </div>
      {/if}
    </SectionBox>

    <SectionBox title="Mood do Mês">
      {#if loadingMood}
        <div class="flex items-center gap-2 py-2"><Spinner size="sm" /></div>
      {:else if moodMonth}
        <div class="mb-4">
          <div class="text-base font-bold text-white">{moodLabel(moodMonth)}</div>
          <div class="text-2xs mt-0.5" style="color:#5a5a78">{moodMonth.tracksAnalyzed ?? 0} faixas analisadas este mês</div>
        </div>
        <div class="space-y-3">
          <MoodBar label="Energia"       value={+(moodMonth.avgEnergy ?? 0).toFixed(1)} />
          <MoodBar label="Valência"      value={+(moodMonth.avgValence ?? 0).toFixed(1)} />
          <MoodBar label="Dançabilidade" value={+(moodMonth.avgDanceability ?? 0).toFixed(1)} />
          <MoodBar label="Diversidade"   value={+(moodMonth.genreDiversity ?? 0).toFixed(1)} />
        </div>
      {:else}
        <div class="py-4 text-center">
          <div class="text-xl mb-1">⬡</div>
          <div class="text-sm text-white">Sem dados do mês</div>
          <div class="text-2xs mt-1" style="color:#5a5a78">Continue ouvindo música</div>
        </div>
      {/if}
    </SectionBox>
  </div>

  <!-- ── Histórico Recente ────────────────────────────────── -->
  <SectionBox noPad title="Histórico Recente">
    {#snippet actions()}
      {#if history.length > 0}
        <span class="text-2xs" style="color:#5a5a78">Últimas {history.length} reproduções</span>
      {/if}
    {/snippet}

    {#if loadingHistory}
      <div class="flex items-center gap-2 px-5 py-6"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Carregando…</span></div>
    {:else if history.length === 0}
      <div class="px-5 py-8 text-center">
        <div class="text-xl mb-2">♪</div>
        <div class="text-sm text-white">Nenhum histórico ainda</div>
        <div class="text-2xs mt-1" style="color:#5a5a78">Toque músicas no Plex para ver aqui</div>
      </div>
    {:else}
      <div class="px-5 pt-1 pb-2">
        {#each history as track}
          <TrackRow
            ratingKey={track.ratingKey}
            title={track.title}
            artist={track.artist ?? track.grandparentTitle}
            album={track.album ?? track.parentTitle}
            playedAt={track.playedAt ?? track.viewedAt}
          />
        {/each}
      </div>
    {/if}
  </SectionBox>

  <!-- ── Descobertas ─────────────────────────────────────── -->
  {#if !loadingDisc && discoveries.length > 0}
    <SectionBox noPad title="Descobertas">
      {#snippet actions()}
        <span class="text-2xs" style="color:#5a5a78">Analisadas · ainda não ouvidas</span>
      {/snippet}

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 px-5 pt-1 pb-5">
        {#each discoveries as t}
          <div class="rounded-xl p-3 border transition-all duration-150 hover:border-accent/25 group"
               style="background:#16161f;border-color:#1e1e2e">
            <div class="text-sm font-medium text-white truncate leading-snug">{t.title ?? '—'}</div>
            <div class="text-2xs truncate mt-0.5" style="color:#5a5a78">{t.artist ?? ''}</div>
            {#if t.energy != null}
              <div class="mt-2">
                <span class="text-2xs font-semibold px-1.5 py-px rounded"
                      style="background:rgba(124,106,245,0.1);color:#9d8eff">
                  ⚡ {(+t.energy).toFixed(1)}
                </span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </SectionBox>
  {/if}

</div>
