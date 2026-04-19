<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';

  import Button      from '../components/ui/Button.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';
  import StatCard    from '../components/ui/StatCard.svelte';

  // ─── State ───────────────────────────────────────────────
  let cacheStats  = $state(null);
  let progress    = $state(null);   // { processed, total, current, running }
  let recent      = $state([]);
  let pollId      = $state(null);

  // Batch options
  let maxSecs     = $state(30);
  let skipExisting = $state(true);

  let loadingCache = $state(true);
  let errorMsg     = $state('');

  onMount(async () => {
    await Promise.allSettled([loadCacheStats(), loadProgress()]);
  });

  async function loadCacheStats() {
    loadingCache = true;
    try {
      const data = await api('GET', '/audio/analysis-cache');
      // tracks is { ratingKey: { ratingKey, title, artist, analysis: {...} } } — convert to array
      const tracksArr = Object.values(data?.tracks ?? {});
      // Normalize for display: flatten analysis fields one level up
      recent = tracksArr.slice(0, 20).map(t => ({
        ...t,
        mood:   t.analysis?.mood   ?? null,
        energy: t.analysis?.energy ?? null,
        bpm:    t.analysis?.bpm    ?? null,
      }));
      cacheStats = {
        analyzedCount: data.size ?? tracksArr.length,
        totalTracks:   data.size ?? tracksArr.length,
        coverage:      100,
        cacheSize:     data.size ?? tracksArr.length,
      };
    } catch (e) { errorMsg = e.message; }
    finally { loadingCache = false; }
  }

  async function loadProgress() {
    try {
      progress = await api('GET', '/audio/batch-progress');
      if (progress?.running && !pollId) startPolling();
    } catch { /* non-critical */ }
  }

  function startPolling() {
    if (pollId) return;
    pollId = setInterval(async () => {
      try {
        progress = await api('GET', '/audio/batch-progress');
        if (!progress?.running) {
          stopPolling();
          await loadCacheStats();
          toast.success('Análise concluída!');
        }
      } catch { stopPolling(); }
    }, 2000);
  }

  function stopPolling() {
    clearInterval(pollId);
    pollId = null;
  }

  async function startBatch() {
    errorMsg = '';
    try {
      await api('POST', '/audio/batch-analyze', {
        maxDurationSecs: maxSecs,
        skipExisting,
      });
      toast('Análise iniciada…');
      await loadProgress();
      startPolling();
    } catch (e) { errorMsg = e.message; }
  }

  async function stopBatch() {
    try {
      await api('POST', '/audio/batch-analyze', { stop: true });
      stopPolling();
      progress = await api('GET', '/audio/batch-progress');
      toast.warn('Análise interrompida');
    } catch (e) { toast.error(e.message); }
  }

  const pct = $derived(
    progress?.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0
  );

  const running = $derived(progress?.running === true);
</script>

<div class="p-6 w-full min-h-full animate-fade-in space-y-6">

  <!-- Header -->
  <div>
    <h1 class="text-2xl font-extrabold text-white tracking-tight">Análise da Biblioteca</h1>
    <p class="text-sm mt-0.5" style="color:#5a5a78">Mood, energia, BPM e gênero para cada faixa</p>
  </div>

  {#if errorMsg}
    <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">
      {errorMsg}<button class="ml-2 opacity-60" onclick={() => errorMsg = ''}>✕</button>
    </div>
  {/if}

  <!-- Stats -->
  {#if !loadingCache && cacheStats}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Analisadas"    value={String(cacheStats.analyzedCount ?? 0)}      icon="◈" accent />
      <StatCard label="Total na Bibl." value={String(cacheStats.totalTracks ?? 0)}        icon="♪" />
      <StatCard label="Cobertura"     value={(cacheStats.coverage ?? 0).toFixed(1) + '%'} icon="%" />
      <StatCard label="Cache"         value={String(cacheStats.cacheSize ?? '—')}         icon="≡" />
    </div>
  {/if}

  <!-- Batch controls -->
  <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
    <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
      <div class="text-sm font-semibold text-white">Análise de Áudio em Lote</div>
    </div>
    <div class="px-5 py-4 space-y-4">

      <!-- Options -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label for="max-secs" class="block text-2xs font-medium mb-1.5" style="color:#5a5a78">
            Duração máx. por faixa (segundos)
          </label>
          <input
            id="max-secs"
            type="number" bind:value={maxSecs} min="5" max="300"
            disabled={running}
            class="w-full rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none transition-colors disabled:opacity-40"
            style="background:#16161f;border:1px solid #1e1e2e"
            onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
            onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
          />
        </div>
        <div class="flex items-end pb-1">
          <label class="flex items-center gap-2 text-sm cursor-pointer select-none" style="color:#8888a8">
            <input type="checkbox" bind:checked={skipExisting} disabled={running} class="accent-[#7c6af5]" />
            Pular faixas já analisadas
          </label>
        </div>
      </div>

      <!-- Progress -->
      {#if progress}
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-2xs" style="color:#5a5a78">
              {running ? 'Analisando…' : 'Pausado'}
              {#if progress.current}<span class="text-white ml-1">{progress.current}</span>{/if}
            </span>
            <span class="text-2xs stat-value" style="color:#5a5a78">{progress.processed ?? 0} / {progress.total ?? '?'} · {pct}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:{pct}%;{running ? '' : 'background:#2e2e4a'}"></div>
          </div>
        </div>
      {/if}

      <!-- Buttons -->
      <div class="flex gap-2">
        {#if !running}
          <Button onclick={startBatch}>◈ Iniciar Análise</Button>
        {:else}
          <Button onclick={stopBatch} variant="danger">
            <Spinner size="xs" />
            Parar
          </Button>
        {/if}
        <Button variant="secondary" onclick={loadCacheStats} loading={loadingCache}>↻ Atualizar</Button>
      </div>

    </div>
  </div>

  <!-- Recently analyzed -->
  {#if recent.length > 0}
    <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
      <div class="px-5 py-4 border-b flex items-center justify-between" style="border-color:#1a1a28">
        <div class="text-sm font-semibold text-white">Analisadas Recentemente</div>
        <span class="text-2xs" style="color:#5a5a78">{recent.length} faixas</span>
      </div>
      <div class="px-5 py-2">
        {#each recent as t}
          <div class="list-row flex items-center gap-3 py-2.5">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-white truncate">{t.title ?? '—'}</div>
              <div class="text-2xs truncate" style="color:#5a5a78">{t.artist ?? ''}</div>
            </div>
            {#if t.mood || t.energy != null}
              <div class="flex gap-1.5 shrink-0">
                {#if t.mood}
                  <span class="text-2xs px-1.5 py-px rounded font-medium" style="background:rgba(124,106,245,0.1);color:#9d8eff">{t.mood}</span>
                {/if}
                {#if t.energy != null}
                  <span class="text-2xs px-1.5 py-px rounded font-medium" style="background:rgba(56,189,248,0.1);color:#38bdf8">⚡ {(+t.energy).toFixed(1)}</span>
                {/if}
                {#if t.bpm}
                  <span class="text-2xs px-1.5 py-px rounded font-medium" style="background:rgba(88,88,120,0.15);color:#8888a8">♩{Math.round(t.bpm)}</span>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

</div>
