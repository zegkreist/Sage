<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import Spinner from '../components/ui/Spinner.svelte';

  let summary     = $state(null);
  let lines       = $state([]);
  let files       = $state([]);
  let loading     = $state(true);
  let loadingLines = $state(false);
  let autoRefresh = $state(false);
  let filterText  = $state('');
  let filterLevel = $state('');      // INFO | WARN | ERROR | DEBUG | ''
  let refreshId   = null;

  const LEVEL_COLOR = {
    INFO:  'color:#1db954',
    WARN:  'color:#f59e0b',
    ERROR: 'color:#f87171',
    DEBUG: 'color:#5a5a78',
    HTTP:  'color:#38bdf8',
  };

  onMount(() => {
    loadAll();
    return () => { if (refreshId) clearInterval(refreshId); };
  });

  async function loadAll() {
    loading = true;
    try {
      const [s, t] = await Promise.all([
        api('GET', '/logs'),
        api('GET', '/logs/today'),
      ]);
      summary = s;
      files   = s.files ?? [];
      lines   = t.lines ?? [];
    } catch (e) {
      toast.error(`Logs: ${e.message}`);
    } finally {
      loading = false;
    }
  }

  async function refreshLines() {
    loadingLines = true;
    try {
      const t = await api('GET', '/logs/today');
      lines = t.lines ?? [];
    } catch { /* silent */ }
    finally { loadingLines = false; }
  }

  function toggleAutoRefresh() {
    autoRefresh = !autoRefresh;
    if (autoRefresh) {
      refreshId = setInterval(refreshLines, 3000);
    } else {
      clearInterval(refreshId);
      refreshId = null;
    }
  }

  async function clearToday() {
    if (!confirm('Zerar o log de hoje?')) return;
    try {
      await api('DELETE', '/logs');
      toast.success('Log de hoje zerado');
      lines = [];
    } catch (e) { toast.error(e.message); }
  }

  async function clearAll() {
    if (!confirm('Remover TODOS os arquivos de log? Esta ação não pode ser desfeita.')) return;
    try {
      const res = await api('DELETE', '/logs/all');
      toast.success(res.message ?? 'Todos os logs removidos');
      lines = [];
      files = [];
    } catch (e) { toast.error(e.message); }
  }

  // ── Filtro ───────────────────────────────────────────────
  let filteredLines = $derived(lines.filter(l => {
    if (filterLevel && !l.includes(`[${filterLevel}`)) return false;
    if (filterText  && !l.toLowerCase().includes(filterText.toLowerCase())) return false;
    return true;
  }));

  function levelFromLine(line) {
    const m = line.match(/\[(INFO|WARN|ERROR|DEBUG|HTTP)\b/);
    return m ? m[1] : null;
  }

  function fmtBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }
</script>

<div class="p-6 w-full min-h-full animate-fade-in flex flex-col gap-5">

  <!-- Header -->
  <div class="flex items-end justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Logs</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Monitoramento e controle dos logs do servidor</p>
    </div>
    <div class="flex gap-2 flex-wrap">
      <button
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="background:rgba(124,106,245,0.12);color:#9d8eff;border:1px solid rgba(124,106,245,0.2)"
        onclick={refreshLines}
        title="Atualizar"
      >↻ Atualizar</button>
      <button
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style={autoRefresh
          ? 'background:rgba(29,185,84,0.12);color:#1db954;border:1px solid rgba(29,185,84,0.25)'
          : 'background:#111118;color:#5a5a78;border:1px solid #1e1e2e'}
        onclick={toggleAutoRefresh}
        title="Auto-refresh a cada 3s"
      >{autoRefresh ? '⏸ Auto ON' : '▶ Auto OFF'}</button>
      <button
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="background:rgba(245,158,11,0.1);color:#f59e0b;border:1px solid rgba(245,158,11,0.2)"
        onclick={clearToday}
        title="Zera o log de hoje"
      >⊘ Zerar hoje</button>
      <button
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="background:rgba(248,113,113,0.1);color:#f87171;border:1px solid rgba(248,113,113,0.2)"
        onclick={clearAll}
        title="Remove todos os arquivos de log"
      >✕ Zerar tudo</button>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center gap-3 py-12"><Spinner /><span class="text-sm" style="color:#5a5a78">Carregando logs…</span></div>
  {:else}

    <!-- Stats row -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Arquivos</div>
        <div class="text-xl font-bold text-white">{files.length}</div>
      </div>
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Linhas hoje</div>
        <div class="text-xl font-bold text-white">{lines.length}</div>
      </div>
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Erros hoje</div>
        <div class="text-xl font-bold" style="color:#f87171">{lines.filter(l => l.includes('[ERROR')).length}</div>
      </div>
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Avisos hoje</div>
        <div class="text-xl font-bold" style="color:#f59e0b">{lines.filter(l => l.includes('[WARN')).length}</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex gap-2 flex-wrap items-center">
      <input
        type="text"
        bind:value={filterText}
        placeholder="Filtrar texto…"
        class="flex-1 min-w-0 rounded-lg px-3 py-2 text-xs text-white transition-colors focus:outline-none"
        style="background:#111118;border:1px solid #1e1e2e;min-width:200px"
      />
      <div class="flex gap-1 p-1 rounded-lg" style="background:#0a0a0f">
        {#each ['', 'INFO', 'WARN', 'ERROR', 'DEBUG', 'HTTP'] as lvl}
          <button
            class="px-2.5 py-1 rounded-md text-2xs font-semibold transition-all"
            style={filterLevel === lvl
              ? 'background:rgba(124,106,245,0.18);color:#9d8eff;border:1px solid rgba(124,106,245,0.25)'
              : 'color:#5a5a78;border:1px solid transparent'}
            onclick={() => filterLevel = lvl}
          >{lvl || 'Todos'}</button>
        {/each}
      </div>
      {#if loadingLines}
        <Spinner size="sm" />
      {/if}
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-4 gap-5 flex-1 min-h-0">

      <!-- Log viewer -->
      <div class="xl:col-span-3 rounded-2xl border overflow-hidden flex flex-col" style="background:#080810;border-color:#1a1a28">
        <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Log de Hoje</div>
          <span class="text-2xs" style="color:#5a5a78">
            {filteredLines.length} de {lines.length} linhas
          </span>
        </div>
        <div class="overflow-y-auto flex-1 font-mono text-2xs leading-5 p-3">
          {#if filteredLines.length === 0}
            <div class="py-8 text-center" style="color:#5a5a78">
              {lines.length === 0 ? 'Nenhum log hoje.' : 'Nenhuma linha corresponde ao filtro.'}
            </div>
          {:else}
            {#each filteredLines as line}
              {@const level = levelFromLine(line)}
              <div
                class="py-0.5 px-1 rounded transition-colors hover:bg-white/5 whitespace-pre-wrap break-all"
                style={level ? LEVEL_COLOR[level] : 'color:#8888a8'}
              >{line}</div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- File list -->
      <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1a1a28">
        <div class="px-4 py-3 border-b" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Arquivos de Log</div>
        </div>
        <div class="divide-y" style="border-color:#1a1a28">
          {#if files.length === 0}
            <div class="px-4 py-6 text-center text-xs" style="color:#5a5a78">Nenhum arquivo</div>
          {:else}
            {#each files as f}
              <div class="px-4 py-3">
                <div class="text-xs text-white truncate font-medium">{f.name}</div>
                <div class="text-2xs mt-0.5" style="color:#5a5a78">{fmtBytes(f.size)}</div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

    </div>
  {/if}
</div>
