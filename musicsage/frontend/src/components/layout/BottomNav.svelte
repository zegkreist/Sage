<script>
  import { currentPage, navigate } from '$lib/stores/router.js';

  // 4 tabs principais + "Mais"
  const MAIN_TABS = [
    { page: 'dashboard',       icon: '◈', label: 'Dashboard' },
    { page: 'recommendations', icon: '✦', label: 'Recomen.' },
    { page: 'playlists',       icon: '≡', label: 'Playlists' },
    { page: 'downloads',       icon: '↓', label: 'Downloads' },
  ];

  const MORE_ITEMS = [
    { page: 'new-playlist',     icon: '+',  label: 'Nova Playlist' },
    { page: 'rewind',           icon: '↺',  label: 'Retrospectiva' },
    { page: 'analysis-library', icon: '⊛',  label: 'Análise de Áudio' },
    { page: 'logs',             icon: '⊞',  label: 'Logs' },
    { page: 'plex-status',      icon: '⚡', label: 'Conexão Plex' },
  ];

  const MORE_PAGES = MORE_ITEMS.map(i => i.page);

  let showMore = $state(false);

  function tap(page) {
    navigate(page);
    showMore = false;
  }

  function toggleMore() {
    showMore = !showMore;
  }

  // Close sheet when navigating away via other means
  $effect(() => {
    if (!MORE_PAGES.includes($currentPage)) showMore = false;
  });
</script>

<!-- ── "Mais" slide-up overlay ──────────────────────────────── -->
{#if showMore}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-40"
    style="background: rgba(0,0,0,0.55);"
    onclick={() => (showMore = false)}
    role="presentation"
  ></div>

  <!-- Sheet -->
  <div
    class="fixed left-0 right-0 z-50 rounded-t-2xl"
    style="
      bottom: var(--mobile-nav-h);
      background: #111118;
      border-top: 1px solid #1e1e2e;
      padding: 12px 0 8px;
      animation: slideUp 200ms ease;
    "
    role="menu"
  >
    <div class="w-8 h-1 rounded-full mx-auto mb-3" style="background:#2a2a3e;"></div>
    <!-- TODO: #3a3a58 mapeado para var(--muted) (token mais próximo disponível) -->
    <div class="text-2xs font-semibold uppercase tracking-widest px-5 mb-2" style="color:var(--muted);">
      Mais opções
    </div>
    {#each MORE_ITEMS as item}
      {@const active = $currentPage === item.page}
      <button
        class="w-full flex items-center gap-4 px-5 py-3 text-left text-sm transition-colors"
        style="{active ? 'color:var(--accent-hi); background:rgba(124,106,245,0.08);' : 'color:var(--dim);'}"
        onclick={() => tap(item.page)}
        role="menuitem"
      >
        <span class="w-5 text-center font-mono text-base">{item.icon}</span>
        <span>{item.label}</span>
        {#if active}
          <span class="ml-auto w-1.5 h-1.5 rounded-full" style="background:var(--accent);"></span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<!-- ── Bottom nav bar ────────────────────────────────────────── -->
<nav
  class="fixed left-0 right-0 bottom-0 z-40 flex items-center"
  style="
    height: var(--mobile-nav-h);
    background: #0e0e15;
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  "
  aria-label="Navegação mobile"
>
  {#each MAIN_TABS as tab}
    {@const active = $currentPage === tab.page}
    <button
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors"
      style="{active ? 'color:var(--accent-hi);' : 'color:#4a4a6a;'}"
      onclick={() => tap(tab.page)}
      aria-current={active ? 'page' : undefined}
    >
      <span class="text-xl font-mono leading-none">{tab.icon}</span>
      <span class="text-2xs font-medium mt-0.5">{tab.label}</span>
      {#if active}
        <span
          class="absolute bottom-0 w-8 h-0.5 rounded-t-full"
          style="background:var(--accent);"
        ></span>
      {/if}
    </button>
  {/each}

  <!-- "Mais" tab -->
  <button
    class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors relative"
    style="{MORE_PAGES.includes($currentPage) || showMore ? 'color:var(--accent-hi);' : 'color:#4a4a6a;'}"
    onclick={toggleMore}
    aria-expanded={showMore}
    aria-label="Mais páginas"
  >
    <span class="text-xl font-mono leading-none">⋯</span>
    <span class="text-2xs font-medium mt-0.5">Mais</span>
    {#if MORE_PAGES.includes($currentPage)}
      <span
        class="absolute bottom-0 w-8 h-0.5 rounded-t-full"
        style="background:var(--accent);"
      ></span>
    {/if}
  </button>
</nav>

<style>
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
</style>
