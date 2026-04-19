<script>
  import { currentPage } from '$lib/stores/router.js';
  import Sidebar from './components/layout/Sidebar.svelte';
  import ToastContainer from './components/ui/ToastContainer.svelte';

  // Pages (lazy imports for code splitting)
  import Dashboard       from './pages/Dashboard.svelte';
  import Recommendations from './pages/Recommendations.svelte';
  import Playlists       from './pages/Playlists.svelte';
  import NewPlaylist     from './pages/NewPlaylist.svelte';
  import Clusters        from './pages/Clusters.svelte';
  import AnalysisLibrary from './pages/AnalysisLibrary.svelte';
  import Downloads       from './pages/Downloads.svelte';
  import Logs            from './pages/Logs.svelte';
</script>

<div class="flex h-screen w-full overflow-hidden bg-bg text-white">
  <Sidebar />

  <main class="flex-1 overflow-y-auto" id="main-content">
    {#if $currentPage === 'dashboard'}
      <Dashboard />
    {:else if $currentPage === 'recommendations'}
      <Recommendations />
    {:else if $currentPage === 'playlists'}
      <Playlists />
    {:else if $currentPage === 'new-playlist'}
      <NewPlaylist />
    {:else if $currentPage === 'clusters'}
      <Clusters />
    {:else if $currentPage === 'analysis-library'}
      <AnalysisLibrary />
    {:else if $currentPage === 'downloads'}
      <Downloads />
    {:else if $currentPage === 'logs'}
      <Logs />
    {:else}
      <Dashboard />
    {/if}
  </main>

  <ToastContainer />
</div>
