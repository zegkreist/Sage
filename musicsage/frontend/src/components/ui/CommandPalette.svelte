<script>
  // Command Palette (⌘K / Ctrl+K) — F7
  // Auto-contida: instala seu próprio keybinding global, sem lógica no App.
  import { onMount } from 'svelte';
  import { navigate } from '$lib/stores/router.js';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';

  let open = $state(false);
  let query = $state('');
  let selected = $state(0);
  let busy = $state(false);

  const ROUTES = [
    { id: 'dashboard',        label: 'Dashboard',        icon: '◈', group: 'Navegação' },
    { id: 'recommendations',  label: 'Recomendações',    icon: '✦', group: 'Navegação' },
    { id: 'playlists',        label: 'Minhas Playlists', icon: '≡', group: 'Navegação' },
    { id: 'new-playlist',     label: 'Nova Playlist',    icon: '+', group: 'Navegação' },
    { id: 'clusters',         label: 'Clusters',         icon: '⬡', group: 'Navegação' },
    { id: 'analysis-library', label: 'Análise de Áudio', icon: '⊛', group: 'Navegação' },
    { id: 'downloads',        label: 'Downloads',        icon: '↓', group: 'Navegação' },
    { id: 'logs',             label: 'Logs',             icon: '⊞', group: 'Navegação' },
    { id: 'plex-status',      label: 'Conexão Plex',     icon: '⚡', group: 'Navegação' },
  ];

  const ACTIONS = [
    {
      id: 'sync-plex',
      label: 'Sincronizar Plex',
      hint: 'Recarrega o token do Plex',
      icon: '⚡',
      group: 'Ações',
      run: async () => {
        try {
          await api('POST', '/plex/reload-token', null, { timeoutMs: 30_000 });
          toast.success('Token do Plex sincronizado');
        } catch (err) {
          toast.error(`Falha ao sincronizar Plex: ${err.message}`);
        }
      },
    },
    {
      id: 'weekly-discovery',
      label: 'Rodar Weekly Discovery',
      hint: 'Gera recomendações da semana',
      icon: '✦',
      group: 'Ações',
      run: async () => {
        try {
          await api('POST', '/weekly/run', null, { timeoutMs: 300_000 });
          toast.success('Weekly Discovery concluído');
        } catch (err) {
          toast.error(`Falha no Weekly Discovery: ${err.message}`);
        }
      },
    },
    {
      id: 'playlist-prompt',
      label: 'Gerar playlist por prompt',
      hint: 'Abrir Nova Playlist',
      icon: '✨',
      group: 'Ações',
      run: () => navigate('new-playlist'),
    },
  ];

  const ALL_COMMANDS = [...ROUTES, ...ACTIONS];

  /** Fuzzy simples: todos os caracteres do filtro aparecem em ordem no alvo. */
  function fuzzyMatch(text, q) {
    const t = text.toLowerCase();
    let i = 0;
    for (const ch of q.toLowerCase()) {
      i = t.indexOf(ch, i);
      if (i === -1) return false;
      i += 1;
    }
    return true;
  }

  const results = $derived(
    query.trim() === ''
      ? ALL_COMMANDS
      : ALL_COMMANDS.filter(
          (c) =>
            fuzzyMatch(c.label, query.trim()) ||
            c.label.toLowerCase().includes(query.trim().toLowerCase()),
        ),
  );

  // Ajusta seleção quando a lista muda
  $effect(() => {
    if (selected >= results.length) selected = Math.max(0, results.length - 1);
  });

  function openPalette() {
    query = '';
    selected = 0;
    open = true;
  }

  function close() {
    open = false;
  }

  async function execute(cmd) {
    if (!cmd || busy) return;
    close();
    if (cmd.id && ROUTES.some((r) => r.id === cmd.id)) {
      navigate(cmd.id);
      return;
    }
    busy = true;
    try {
      await cmd.run();
    } finally {
      busy = false;
    }
  }

  function onKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open ? close() : openPalette();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = (selected + 1) % Math.max(1, results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected - 1 + results.length) % Math.max(1, results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(results[selected]);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  let inputEl;
  $effect(() => {
    if (open && inputEl) setTimeout(() => inputEl?.focus(), 0);
  });
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Botão de atalho na sidebar (discreto) -->
{#snippet trigger()}
  <button
    class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-2xs font-medium transition-colors hover:text-white"
    style="color:var(--muted); border:1px solid var(--border); background:rgba(255,255,255,0.03);"
    onclick={openPalette}
    title="Abrir command palette (Ctrl+K)"
  >
    <span aria-hidden="true">⌘</span>
    <span>Comandos</span>
    <kbd class="ml-auto px-1.5 rounded text-2xs" style="border:1px solid var(--border); color:var(--muted);">K</kbd>
  </button>
{/snippet}

{#if open}
  <div
    class="fixed inset-0 flex items-start justify-center pt-[12vh] px-4"
    style="z-index: 9999; background: rgba(5,5,10,0.6); backdrop-filter: blur(4px);"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
  >
    <div
      class="glass card w-full max-w-lg overflow-hidden"
      style="z-index: 10000; box-shadow: 0 24px 64px rgba(0,0,0,0.6);"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <!-- Input -->
      <div class="flex items-center gap-3 px-4 py-3" style="border-bottom:1px solid var(--border);">
        <span class="text-muted" aria-hidden="true">⌘</span>
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={() => (selected = 0)}
          class="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-muted"
          placeholder="Buscar comandos…"
          aria-label="Buscar comandos"
        />
        <kbd class="px-1.5 py-0.5 rounded text-2xs" style="border:1px solid var(--border); color:var(--muted);">Esc</kbd>
      </div>

      <!-- Lista -->
      <ul class="max-h-80 overflow-y-auto py-1.5 m-0 list-none" role="listbox" aria-label="Comandos">
        {#each results as cmd, i (cmd.id)}
          {@const isRoute = ROUTES.some((r) => r.id === cmd.id)}
          <li role="option" aria-selected={i === selected}>
            <button
              class="w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors
                     {i === selected ? 'text-white' : 'text-muted hover:text-white'}"
              style="{i === selected ? 'background:rgba(124,106,245,0.15);' : ''}"
              onmouseenter={() => (selected = i)}
              onclick={() => execute(cmd)}
            >
              <span class="w-5 text-center shrink-0" aria-hidden="true">{cmd.icon}</span>
              <span class="truncate">{cmd.label}</span>
              {#if cmd.hint}
                <span class="truncate text-2xs ml-1" style="color:var(--muted)">{cmd.hint}</span>
              {/if}
              <span class="ml-auto text-2xs shrink-0" style="color:var(--muted)">
                {isRoute ? '↵ navegar' : '↵ executar'}
              </span>
            </button>
          </li>
        {:else}
          <li class="px-4 py-6 text-center text-sm text-muted">Nenhum comando encontrado</li>
        {/each}
      </ul>

      <!-- Rodapé -->
      <div
        class="flex items-center gap-4 px-4 py-2 text-2xs"
        style="border-top:1px solid var(--border); color:var(--muted);"
      >
        <span>↑↓ navegar</span>
        <span>↵ executar</span>
        <span class="ml-auto">{results.length} comando{results.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  </div>
{/if}
