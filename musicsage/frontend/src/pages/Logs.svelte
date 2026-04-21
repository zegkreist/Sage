<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import Spinner from '../components/ui/Spinner.svelte';

  let files        = $state([]);
  let lines        = $state([]);
  let selectedFile = $state(null);   // null = hoje
  let loading      = $state(true);
  let loadingLines = $state(false);
  let autoRefresh  = $state(false);
  let filterText   = $state('');
  let filterLevel  = $state('');     // INFO | WARN | ERROR | DEBUG | ''
  let refreshId    = null;
  let logEl        = $state(null);   // bind:this para o container de scroll
  let autoScroll   = $state(true);

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

  function todayName() {
    return `musicsage-${new Date().toISOString().slice(0, 10)}.log`;
  }

  async function loadAll() {
    loading = true;
    try {
      const [filesRes, linesRes] = await Promise.all([
        api('GET', '/logs/files'),
        api('GET', '/logs/today'),
      ]);
      files        = filesRes.files ?? [];
      lines        = linesRes.lines ?? [];
      selectedFile = null;
    } catch (e) {
      toast.error(`Logs: ${e.message}`);
    } finally {
      loading = false;
    }
  }

  async function loadFile(name) {
    loadingLines = true;
    try {
      if (!name) {
        const t  = await api('GET', '/logs/today');
        lines    = t.lines ?? [];
        selectedFile = null;
      } else {
        const t  = await api('GET', `/logs/file/${encodeURIComponent(name)}`);
        lines    = t.lines ?? [];
        selectedFile = name;
      }
      scrollToBottom();
    } catch (e) {
      toast.error(`Erro ao carregar ${name ?? 'hoje'}: ${e.message}`);
    } finally {
      loadingLines = false;
    }
  }

  async function refreshLines() {
    loadingLines = true;
    try {
      if (!selectedFile) {
        const t = await api('GET', '/logs/today');
        lines   = t.lines ?? [];
      } else {
        const t = await api('GET', `/logs/file/${encodeURIComponent(selectedFile)}`);
        lines   = t.lines ?? [];
      }
      if (autoScroll) scrollToBottom();
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

  function scrollToBottom() {
    if (logEl) setTimeout(() => { logEl.scrollTop = logEl.scrollHeight; }, 0);
  }

  async function clearToday() {
    if (!confirm('Zerar o log de hoje?')) return;
    try {
      await api('DELETE', '/logs');
      toast.success('Log de hoje zerado');
      if (!selectedFile) lines = [];
    } catch (e) { toast.error(e.message); }
  }

  async function clearAll() {
    if (!confirm('Remover TODOS os arquivos de log? Esta ação não pode ser desfeita.')) return;
    try {
      const res = await api('DELETE', '/logs/all');
      toast.success(res.message ?? 'Todos os logs removidos');
      lines = []; files = []; selectedFile = null;
    } catch (e) { toast.error(e.message); }
  }

  let filteredLines = $derived(lines.filter(l => {
    if (filterLevel && !l.includes(`[${filterLevel}`)) return false;
    if (filterText  && !l.toLowerCase().includes(filterText.toLowerCase())) return false;
    return true;
  }));

  let errorCount = $derived(lines.filter(l => l.includes('[ERROR')).length);
  let warnCount  = $derived(lines.filter(l => l.includes('[WARN' )).length);

  function levelFromLine(line) {
    const m = line.match(/\[(INFO|WARN|ERROR|DEBUG|HTTP)\b/);
    return m ? m[1] : null;
  }

  function fmtBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  function fileLabel(f) {
    const m = f.name.match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : f.name;
  }

  function isSelected(f) {
    if (!f) return selectedFile === null;
    return selectedFile === f.name;
  }
</script>

<div class="p-6 w-full min-h-full animate-fade-in flex flex-col gap-5">

  <!-- Header -->
  <div class="flex items-end justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Logs</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">
        {selectedFile ? selectedFile : 'Hoje — ' + todayName()}
      </p>
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
        style={autoScroll
          ? 'background:rgba(29,185,84,0.08);color:#1db954;border:1px solid rgba(29,185,84,0.2)'
          : 'background:#111118;color:#5a5a78;border:1px solid #1e1e2e'}
        onclick={() => { autoScroll = !autoScroll; if (autoScroll) scrollToBottom(); }}
        title="Rolar para o final automaticamente"
      >⬇ Scroll</button>
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
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Linhas</div>
        <div class="text-xl font-bold text-white">{lines.length}</div>
      </div>
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Erros</div>
        <div class="text-xl font-bold" style="color:#f87171">{errorCount}</div>
      </div>
      <div class="rounded-2xl border p-4" style="background:#111118;border-color:#1a1a28">
        <div class="text-2xs uppercase tracking-wider mb-1" style="color:#5a5a78">Avisos</div>
        <div class="text-xl font-bold" style="color:#f59e0b">{warnCount}</div>
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

    <div class="grid grid-cols-1 xl:grid-cols-4 gap-5" style="min-height:0">

      <!-- Log viewer -->
      <div class="xl:col-span-3 rounded-2xl border flex flex-col" style="background:#080810;border-color:#1a1a28;height:600px">
        <div class="flex items-center justify-between px-4 py-3 border-b shrink-0" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">
            {selectedFile ?? 'Hoje'}
          </div>
          <span class="text-2xs" style="color:#5a5a78">
            {filteredLines.length} de {lines.length} linhas
          </span>
        </div>
        <div
          bind:this={logEl}
          class="overflow-y-auto font-mono text-2xs leading-5 p-3"
          style="flex:1;min-height:0"
        >
          {#if filteredLines.length === 0}
            <div class="py-8 text-center" style="color:#5a5a78">
              {lines.length === 0 ? 'Nenhum log neste arquivo.' : 'Nenhuma linha corresponde ao filtro.'}
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
      <div class="rounded-2xl border flex flex-col" style="background:#111118;border-color:#1a1a28;height:600px">
        <div class="px-4 py-3 border-b shrink-0" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Arquivos de Log</div>
        </div>
        <div class="overflow-y-auto flex-1 divide-y" style="border-color:#1a1a28;min-height:0">
          <button
            class="w-full text-left px-4 py-3 transition-colors hover:bg-white/5"
            style={isSelected(null)
              ? 'background:rgba(124,106,245,0.12);border-left:2px solid #7c6af5'
              : 'border-left:2px solid transparent'}
            onclick={() => loadFile(null)}
          >
            <div class="text-xs font-semibold" style={isSelected(null) ? 'color:#9d8eff' : 'color:#e0e0e8'}>Hoje</div>
            <div class="text-2xs mt-0.5" style="color:#5a5a78">{todayName()}</div>
          </button>
          {#if files.length === 0}
            <div class="px-4 py-6 text-center text-xs" style="color:#5a5a78">Nenhum arquivo</div>
          {:else}
            {#each files as f}
              <button
                class="w-full text-left px-4 py-3 transition-colors hover:bg-white/5"
                style={isSelected(f)
                  ? 'background:rgba(124,106,245,0.1);border-left:2px solid #7c6af5'
                  : 'border-left:2px solid transparent'}
                onclick={() => loadFile(f.name)}
              >
                <div class="text-xs font-medium" style={isSelected(f) ? 'color:#9d8eff' : 'color:#c0c0d0'}>{fileLabel(f)}</div>
                <div class="text-2xs mt-0.5" style="color:#5a5a78">{fmtBytes(f.size)}</div>
              </button>
            {/each}
          {/if}
        </div>
      </div>

    </div>
  {/if}
</div>
