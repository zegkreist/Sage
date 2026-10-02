<script>
  import Dashboard       from '../../pages/Dashboard.svelte';
  import Recommendations from '../../pages/Recommendations.svelte';
  import Playlists       from '../../pages/Playlists.svelte';
  import NewPlaylist     from '../../pages/NewPlaylist.svelte';
  import Clusters        from '../../pages/Clusters.svelte';
  import AnalysisLibrary from '../../pages/AnalysisLibrary.svelte';
  import Downloads       from '../../pages/Downloads.svelte';
  import Logs            from '../../pages/Logs.svelte';
  import PlexStatus      from '../../pages/PlexStatus.svelte';
  import Rewind          from '../../pages/Rewind.svelte';

  let { page } = $props();

  const ROUTES = {
    'dashboard':         Dashboard,
    'recommendations':   Recommendations,
    'playlists':         Playlists,
    'new-playlist':      NewPlaylist,
    'clusters':          Clusters,
    'analysis-library':  AnalysisLibrary,
    'downloads':         Downloads,
    'logs':              Logs,
    'plex-status':       PlexStatus,
    'rewind':            Rewind,
  };

  const Component = $derived(ROUTES[page] ?? Dashboard);
</script>

<svelte:component this={Component} />
