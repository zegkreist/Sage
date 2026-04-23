<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { deriveMoodLabel, relTime } from '$lib/utils.js';
  import { users, selectedUserId } from '$lib/stores/user.js';

  import SectionBox        from '../components/layout/SectionBox.svelte';
  import StatCard          from '../components/ui/StatCard.svelte';
  import MoodBar           from '../components/ui/MoodBar.svelte';
  import TrackRow          from '../components/data/TrackRow.svelte';
  import Spinner           from '../components/ui/Spinner.svelte';
  import ShareStoryModal   from '../components/ui/ShareStoryModal.svelte';

  // ─── State ───────────────────────────────────────────────
  let stats       = $state(null);
  let period      = $state('month');  // week | month | year
  let metrics     = $state(null);
  let moodDay     = $state(null);
  let moodMonth   = $state(null);
  let curiosidades = $state([]);
  let history     = $state([]);
  let discoveries = $state([]);
  let subgenreDistrib = $state([]);  // [{ name, count, pct }]

  let loadingStats    = $state(true);
  let loadingMetrics  = $state(false);
  let loadingMood     = $state(true);
  let loadingHistory  = $state(true);
  let loadingDisc     = $state(true);

  // Compartilhar Stories
  let showShare  = $state(false);
  let shareTab   = $state('artists');

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
      const tracksArr = Object.values(cache?.tracks ?? {});
      const played = new Set((history ?? []).map(t => t.ratingKey));

      // Build subgenre distribution from full cache (all analyzed tracks)
      const sgMap = {};
      for (const t of tracksArr) {
        const sg = t.analysis?.subgenre;
        const g  = t.analysis?.genre;
        const useSubgenre = sg && sg !== 'unknown' && sg.toLowerCase() !== (g ?? '').toLowerCase();
        const key = useSubgenre ? sg : (g && g !== 'unknown' ? g : null);
        if (key) sgMap[key] = (sgMap[key] || 0) + 1;
      }
      const total = Object.values(sgMap).reduce((a, b) => a + b, 0);
      subgenreDistrib = Object.entries(sgMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => ({ name, count, pct: total > 0 ? Math.round(count / total * 100) : 0 }));

      // Discoveries: unplayed tracks sorted by energy desc
      discoveries = tracksArr
        .filter(t => !played.has(t.ratingKey) && t.analysis)
        .sort((a, b) => (b.analysis?.energy ?? 0) - (a.analysis?.energy ?? 0))
        .slice(0, 12)
        .map(t => ({
          ...t,
          energy:   t.analysis?.energy ?? null,
          mood:     t.analysis?.mood ?? null,
          subgenre: t.analysis?.subgenre && t.analysis.subgenre !== 'unknown' ? t.analysis.subgenre
                  : t.analysis?.genre && t.analysis.genre !== 'unknown'     ? t.analysis.genre
                  : null,
        }));
    } catch { /* non-critical */ }
    finally { loadingDisc = false; }
  }

  // ─── Reactivity ──────────────────────────────────────────
  $effect(() => { if (period || $selectedUserId !== undefined) { metrics = null; loadMetrics(); } });

  // ─── Helpers ─────────────────────────────────────────────
  function moodLabel(m) {
    if (!m) return 'Carregando…';
    return deriveMoodLabel(m.avgEnergy, m.avgValence, m.avgDanceability, m.topMoods?.[0]);
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
      {#if $users.length > 1}
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
        <div class="flex items-center gap-2">
          <button
            onclick={() => { shareTab = 'curiosidades'; showShare = true; }}
            title="Compartilhar nos Stories"
            style="background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:8px;
                   color:#5a5a78;font-size:13px;line-height:1;transition:color .15s"
            onmouseenter={(e) => e.currentTarget.style.color='#1db954'}
            onmouseleave={(e) => e.currentTarget.style.color='#5a5a78'}
          >⬆ Story</button>
          <span class="text-2xs font-medium px-2 py-0.5 rounded-full"
                style="background:rgba(124,106,245,0.12);color:#9d8eff;border:1px solid rgba(124,106,245,0.2)">
            {curiosidades.length} insights
          </span>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each curiosidades as fact, i}
          {@const isAccent = i < 2}
          {@const accentColor = i === 0 ? '#7c6af5' : i === 1 ? '#1db954' : i === 2 ? '#38bdf8' : '#5a5a78'}
          <div
            class="relative rounded-2xl p-4 border transition-all duration-200 cursor-default overflow-hidden"
            style="background:#111118;border-color:{isAccent ? accentColor + '33' : '#1e1e2e'}"
          >
            <!-- subtle corner glow for first 3 -->
            {#if i < 3}
              <div class="absolute top-0 right-0 w-28 h-28 rounded-full pointer-events-none"
                   style="background:radial-gradient(circle, {accentColor}18 0%, transparent 70%);transform:translate(30%,-30%)"></div>
            {/if}

            {#if fact.type === 'pct'}
              <!-- PCT card: large % number + mini bar -->
              <div class="flex items-start justify-between gap-2 mb-3">
                <span class="text-xl leading-none">{fact.icon ?? '✦'}</span>
                <span class="text-2xl font-extrabold leading-none" style="color:{accentColor}">{fact.value}</span>
              </div>
              <div class="w-full h-1 rounded-full mb-2" style="background:#1c1c28">
                <div class="h-full rounded-full transition-all duration-700"
                     style="width:{fact.pct ?? 0}%;background:{accentColor};box-shadow:0 0 6px {accentColor}44"></div>
              </div>
              <div class="text-xs font-medium text-white leading-snug">{fact.label}</div>
              {#if fact.sub}<div class="text-2xs mt-0.5" style="color:#5a5a78">{fact.sub}</div>{/if}

            {:else if fact.type === 'track'}
              <!-- TRACK card: label small, title prominent -->
              <div class="text-xl mb-2 leading-none">{fact.icon ?? '✦'}</div>
              <div class="text-2xs font-semibold uppercase tracking-wider mb-1.5" style="color:{accentColor}">{fact.label}</div>
              <div class="text-sm font-bold text-white leading-snug truncate">{fact.value ?? '—'}</div>
              {#if fact.sub}
                <div class="text-2xs mt-1 truncate" style="color:#8888a8">{fact.sub}</div>
              {/if}

            {:else if fact.type === 'list'}
              <!-- LIST card: ranked genre/subgenre list -->
              <div class="text-xl mb-2 leading-none">{fact.icon ?? '✦'}</div>
              <div class="text-2xs font-semibold uppercase tracking-wider mb-2" style="color:{accentColor}">{fact.label}</div>
              <div class="space-y-1.5">
                {#each (fact.items ?? []).slice(0, 5) as item, idx}
                  {@const itemPct = fact.items?.[0]?.count > 0 ? Math.round(item.count / fact.items[0].count * 100) : 0}
                  <div class="text-2xs">
                    <div class="flex justify-between mb-0.5">
                      <span class="truncate text-white" style="max-width:75%">{idx + 1}. {item.name}</span>
                      <span style="color:#5a5a78">{item.count}</span>
                    </div>
                    <div class="h-0.5 rounded-full" style="background:#1c1c28">
                      <div class="h-0.5 rounded-full" style="width:{itemPct}%;background:{accentColor}88"></div>
                    </div>
                  </div>
                {/each}
              </div>
              {#if fact.sub}<div class="text-2xs mt-2" style="color:#5a5a78">{fact.sub}</div>{/if}

            {:else}
              <div class="text-xl mb-2 leading-none">{fact.icon ?? '✦'}</div>
              <div class="text-2xs font-semibold uppercase tracking-wider mb-1" style="color:#5a5a78">{fact.label}</div>
              <div class="text-lg font-extrabold leading-tight" style="color:{isAccent ? accentColor : 'white'}">{fact.value ?? fact.text ?? '—'}</div>
              {#if fact.sub}
                <div class="text-2xs mt-1" style="color:#5a5a78">{fact.sub}</div>
              {/if}
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
            <div class="flex items-center justify-between mb-3">
              <div class="text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Top Artistas</div>
              <button
                onclick={() => { shareTab = 'artists'; showShare = true; }}
                title="Compartilhar nos Stories"
                style="background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:8px;
                       color:#5a5a78;font-size:13px;line-height:1;transition:color .15s"
                onmouseenter={(e) => e.currentTarget.style.color='#7c6af5'}
                onmouseleave={(e) => e.currentTarget.style.color='#5a5a78'}
              >⬆ Story</button>
            </div>
            {#each (metrics.topArtists ?? []).slice(0,10) as a, i}
              <div class="list-row flex items-center gap-3 py-2">
                <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                {#if a.thumb}
                  <img src="/api/library/thumb?path={encodeURIComponent(a.thumb)}" class="w-7 h-7 rounded object-cover shrink-0" alt="" />
                {:else}
                  <div class="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs" style="background:#1e1e2e;color:#5a5a78">◈</div>
                {/if}
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-white truncate">{a.artist ?? a.title ?? a.name ?? '?'}</div>
                  <div class="text-2xs truncate" style="color:#5a5a78">{a.analysisGenre ?? a.genres?.[0] ?? (a.totalMinutes ? a.totalMinutes + ' min' : '')}</div>
                </div>
                <span class="text-2xs stat-value" style="color:#5a5a78">{fmt(a.playCount ?? 0)}</span>
              </div>
            {/each}
          </div>

          <!-- Top Tracks -->
          <div>
            <div class="flex items-center justify-between mb-3">
              <div class="text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Top Faixas</div>
              <button
                onclick={() => { shareTab = 'tracks'; showShare = true; }}
                title="Compartilhar nos Stories"
                style="background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:8px;
                       color:#5a5a78;font-size:13px;line-height:1;transition:color .15s"
                onmouseenter={(e) => e.currentTarget.style.color='#7c6af5'}
                onmouseleave={(e) => e.currentTarget.style.color='#5a5a78'}
              >⬆ Story</button>
            </div>
            {#each (metrics.topTracks ?? []).slice(0,10) as t, i}
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

          <!-- Top Genres (analysis-based when available, fallback to Plex tags) -->
          {#if metrics.topAnalysisGenres?.length >= 3}
            {@const genreSource = metrics.topAnalysisGenres}
            <div>
              <div class="flex items-center gap-2 mb-3">
                <div class="text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Gêneros</div>
                <span class="text-2xs px-1.5 py-px rounded" style="background:rgba(29,185,84,0.1);color:#1db954;border:1px solid rgba(29,185,84,0.2)">da análise</span>
              </div>
              {#each genreSource.slice(0,10) as g, i}
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
          {:else}
            <div>
              <div class="flex items-center gap-2 mb-3">
                <div class="text-2xs font-semibold uppercase tracking-wider" style="color:#5a5a78">Gêneros</div>
                <span class="text-2xs px-1.5 py-px rounded" style="color:#3a3a58;border:1px solid #1e1e2e">Plex tags</span>
              </div>
              {#each (metrics.topGenres ?? []).slice(0,10) as g, i}
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
          {/if}

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
          <MoodBar label="Positividade"  value={+(moodDay.avgValence ?? 0).toFixed(1)} />
          <MoodBar label="Dançabilidade" value={+(moodDay.avgDanceability ?? 0).toFixed(1)} />
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
          <MoodBar label="Positividade"  value={+(moodMonth.avgValence ?? 0).toFixed(1)} />
          <MoodBar label="Dançabilidade" value={+(moodMonth.avgDanceability ?? 0).toFixed(1)} />
          <MoodBar label="Diversidade"   value={Math.min(10, (moodMonth.topGenres?.length ?? 0) * 2)} />
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
        <span class="text-2xs" style="color:#5a5a78">Mais energéticas · ainda não ouvidas</span>
      {/snippet}

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 px-5 pt-1 pb-5">
        {#each discoveries as t}
          <div class="rounded-xl p-3 border transition-all duration-150 hover:border-accent/25"
               style="background:#16161f;border-color:#1e1e2e">
            <div class="text-sm font-medium text-white truncate leading-snug">{t.title ?? '—'}</div>
            <div class="text-2xs truncate mt-0.5" style="color:#5a5a78">{t.artist ?? ''}</div>
            <div class="flex items-center gap-1.5 mt-2 flex-wrap">
              {#if t.energy != null}
                <span class="text-2xs font-semibold px-1.5 py-px rounded"
                      style="background:rgba(124,106,245,0.1);color:#9d8eff">⚡ {(+t.energy).toFixed(0)}</span>
              {/if}
              {#if t.subgenre}
                <span class="text-2xs px-1.5 py-px rounded truncate"
                      style="background:rgba(56,189,248,0.08);color:#38bdf8;max-width:100%">{t.subgenre}</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </SectionBox>
  {/if}

  <!-- ── Mapa de Subgêneros (do cache de análise) ─────────── -->
  {#if subgenreDistrib.length >= 3}
    <SectionBox noPad title="Mapa de Subgêneros">
      {#snippet actions()}
        <span class="text-2xs" style="color:#5a5a78">Distribuição do cache de análise</span>
      {/snippet}
      <div class="px-5 pt-2 pb-5">
        <div class="space-y-2">
          {#each subgenreDistrib as sg, i}
            {@const maxCount = subgenreDistrib[0]?.count ?? 1}
            {@const barPct = Math.round(sg.count / maxCount * 100)}
            {@const barColor = i === 0 ? '#7c6af5' : i === 1 ? '#1db954' : i === 2 ? '#38bdf8' : i < 5 ? '#f59e0b' : '#3a3a58'}
            <div class="flex items-center gap-3">
              <div class="text-2xs text-right shrink-0" style="width:3.5rem;color:#5a5a78">{sg.pct}%</div>
              <div class="flex-1">
                <div class="flex items-center justify-between mb-0.5">
                  <span class="text-xs text-white truncate" style="max-width:70%">{sg.name}</span>
                  <span class="text-2xs" style="color:#5a5a78">{sg.count} faixas</span>
                </div>
                <div class="h-1 rounded-full" style="background:#1c1c28">
                  <div class="h-1 rounded-full transition-all duration-500"
                       style="width:{barPct}%;background:{barColor};box-shadow:0 0 4px {barColor}55"></div>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </SectionBox>
  {/if}

</div>

<!-- ── Modal de Stories ─────────────────────────────────── -->
<ShareStoryModal
  bind:show={showShare}
  initTab={shareTab}
  artists={metrics?.topArtists ?? []}
  tracks={metrics?.topTracks ?? []}
  curiosidades={curiosidades}
  summary={metrics?.summary ?? null}
  period={period}
/>
