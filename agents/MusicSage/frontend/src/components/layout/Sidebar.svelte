<script>
  import { currentPage, navigate } from '$lib/stores/router.js';
  import { onMount } from 'svelte';

  const navGroups = [
    {
      label: 'Biblioteca',
      items: [
        { page: 'dashboard',         icon: '◈',  label: 'Dashboard' },
        { page: 'recommendations',   icon: '✦',  label: 'Recomendações' },
        { page: 'clusters',          icon: '⬡',  label: 'Clusters' },
        { page: 'analysis-library',  icon: '⊛',  label: 'Análise de Áudio' },
      ],
    },
    {
      label: 'Playlists',
      items: [
        { page: 'playlists',     icon: '≡',  label: 'Minhas Playlists' },
        { page: 'new-playlist',  icon: '+',  label: 'Nova Playlist' },
      ],
    },
    {
      label: 'Ferramentas',
      items: [
        { page: 'downloads', icon: '↓', label: 'Downloads' },
        { page: 'logs',      icon: '⊞', label: 'Logs' },
      ],
    },
  ];

  let health = $state('unknown');

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      health = res.ok ? 'ok' : 'error';
    } catch {
      health = 'error';
    }
  }

  onMount(() => {
    checkHealth();
    const id = setInterval(checkHealth, 30_000);
    return () => clearInterval(id);
  });
</script>

<nav
  class="flex flex-col h-full shrink-0 overflow-y-auto hide-scrollbar"
  style="width: var(--sidebar-w); background: #0e0e15; border-right: 1px solid #1a1a28;"
  aria-label="Navegação principal"
>
  <!-- Logo / Brand -->
  <div class="px-5 pt-6 pb-5 shrink-0">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-gradient-accent flex items-center justify-center text-white text-sm font-bold shadow-glow-sm shrink-0">
        M
      </div>
      <div>
        <div class="text-sm font-semibold text-white tracking-tight">MusicSage</div>
        <div class="text-2xs text-muted mt-px">Plex Intelligence</div>
      </div>
    </div>
  </div>

  <!-- Nav groups -->
  <div class="flex-1 px-3 pb-4 space-y-5">
    {#each navGroups as group}
      <div>
        <div class="px-3 mb-1 text-2xs font-semibold uppercase tracking-widest" style="color:#3a3a58">
          {group.label}
        </div>
        <div class="space-y-px">
          {#each group.items as item}
            {@const active = $currentPage === item.page}
            <button
              class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-all duration-150 relative
                     {active ? 'nav-active' : 'text-muted hover:text-soft hover:bg-surface2'}"
              onclick={() => navigate(item.page)}
              aria-current={active ? 'page' : undefined}
            >
              <span
                class="w-5 h-5 flex items-center justify-center text-base shrink-0 transition-colors font-mono
                       {active ? 'text-accent' : ''}"
                aria-hidden="true"
              >{item.icon}</span>
              <span class="truncate">{item.label}</span>
              {#if active}
                <span class="ml-auto w-1.5 h-1.5 rounded-full bg-accent shrink-0"></span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <!-- Footer: health -->
  <div class="px-5 py-4 shrink-0" style="border-top: 1px solid #1a1a28;">
    <div class="flex items-center gap-2.5">
      <span
        class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors
               {health === 'ok' ? 'bg-positive' : health === 'error' ? 'bg-danger' : 'bg-warn'}"
      ></span>
      <span class="text-2xs font-medium" style="color:#3a3a58">
        {health === 'ok' ? 'Servidor online' : health === 'error' ? 'Offline' : 'Verificando…'}
      </span>
    </div>
  </div>
</nav>

