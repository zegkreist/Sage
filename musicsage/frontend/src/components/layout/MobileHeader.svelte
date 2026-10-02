<script>
  import { currentPage } from '$lib/stores/router.js';

  const PAGE_LABELS = {
    'dashboard':        'Dashboard',
    'recommendations':  'Recomendações',
    'playlists':        'Playlists',
    'new-playlist':     'Nova Playlist',
    'analysis-library': 'Análise de Áudio',
    'downloads':        'Downloads',
    'logs':             'Logs',
    'plex-status':      'Conexão Plex',
  };
</script>

<header
  class="flex items-center gap-3 px-4 shrink-0"
  style="
    height: var(--mobile-header-h);
    background: #0e0e15;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 50;
  "
>
  <!-- Brand mark -->
  <div class="w-7 h-7 rounded-lg bg-gradient-accent flex items-center justify-center text-white text-xs font-bold shadow-glow-sm shrink-0">
    M
  </div>

  <!-- Current page title -->
  <span class="text-sm font-semibold text-white tracking-tight truncate flex-1">
    {PAGE_LABELS[$currentPage] ?? 'MusicSage'}
  </span>

  <!-- Status dot -->
  <div class="w-1.5 h-1.5 rounded-full shrink-0" style="background:#1db954;" title="Servidor online"></div>
</header>
