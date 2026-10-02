<script>
  import { onMount } from 'svelte';
  import { currentPage } from '$lib/stores/router.js';
  import { isMobile } from '$lib/stores/device.js';
  import { loadFavorites } from '$lib/stores/favorites.js';
  import Sidebar from './components/layout/Sidebar.svelte';
  import MobileHeader from './components/layout/MobileHeader.svelte';
  import BottomNav from './components/layout/BottomNav.svelte';
  import ToastContainer from './components/ui/ToastContainer.svelte';
  import RouteOutlet from './components/layout/RouteOutlet.svelte';
  import CommandPalette from './components/ui/CommandPalette.svelte';
  import { startDownloadsPoller } from '$lib/stores/downloads.js';

  // Favoritos são lidos por várias páginas — carrega uma vez no boot
  onMount(loadFavorites);
  // Poller global de downloads — emite toasts quando terminam/falham
  onMount(startDownloadsPoller);
</script>

{#if $isMobile}
  <!-- ── Mobile layout ───────────────────────────────────── -->
  <div class="flex flex-col h-screen w-full overflow-hidden bg-bg text-white">
    <MobileHeader />

    <main
      class="flex-1 overflow-y-auto"
      id="main-content"
      style="padding-bottom: var(--mobile-nav-h);"
    >
      <RouteOutlet page={$currentPage} />
    </main>

    <BottomNav />
    <ToastContainer />
    <CommandPalette />
  </div>

{:else}
  <!-- ── Desktop layout ──────────────────────────────────── -->
  <div class="flex h-screen w-full overflow-hidden bg-bg text-white">
    <Sidebar />

    <main class="flex-1 overflow-y-auto" id="main-content">
      <RouteOutlet page={$currentPage} />
    </main>

    <ToastContainer />
    <CommandPalette />
  </div>
{/if}
