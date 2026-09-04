<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { playlists, selectedPlaylistId, loadPlaylists } from '$lib/stores/playlists.js';
  import { navigate } from '$lib/stores/router.js';
  import { isMobile } from '$lib/stores/device.js';

  import Button   from '../components/ui/Button.svelte';
  import Spinner  from '../components/ui/Spinner.svelte';
  import TrackRow from '../components/data/TrackRow.svelte';

  let loading        = $state(true);
  let loadingDetail  = $state(false);
  let detail         = $state(null);
  let editName       = $state('');
  let isRenaming     = $state(false);
  let savingName     = $state(false);
  let pushing        = $state(false);
  let deleting       = $state(false);
  let error          = $state('');
  let mobileView     = $state('list'); // 'list' | 'detail'

  onMount(async () => {
    loading = true;
    await loadPlaylists();
    loading = false;

    // auto-select first playlist only on desktop
    if ($playlists.length > 0 && !$selectedPlaylistId && !$isMobile) {
      selectPlaylist($playlists[0].id ?? $playlists[0].ratingKey);
    }
  });

  async function selectPlaylist(id) {
    selectedPlaylistId.set(id);
    detail        = null;
    loadingDetail = true;
    error         = '';
    if ($isMobile) mobileView = 'detail';
    try {
      detail   = await api('GET', `/playlists/${id}`);
      editName = detail.title ?? detail.name ?? '';
    } catch (e) {
      error = e.message;
    } finally {
      loadingDetail = false;
    }
  }

  function goBackToList() {
    mobileView = 'list';
    selectedPlaylistId.set(null);
    detail = null;
    error  = '';
  }

  async function saveRename() {
    if (!editName.trim() || !$selectedPlaylistId) return;
    savingName = true;
    try {
      await api('PATCH', `/playlists/${$selectedPlaylistId}`, { title: editName.trim() });
      detail = { ...detail, title: editName.trim(), name: editName.trim() };
      isRenaming = false;
      toast.success('Playlist renomeada');
      await loadPlaylists();
    } catch (e) { toast.error(e.message); }
    finally { savingName = false; }
  }

  async function removeTrack(ratingKey) {
    if (!$selectedPlaylistId) return;
    try {
      await api('PATCH', `/playlists/${$selectedPlaylistId}`, { removeTrack: ratingKey });
      detail = {
        ...detail,
        tracks: (detail.tracks ?? []).filter(t => t.ratingKey !== ratingKey),
      };
      toast.success('Faixa removida');
    } catch (e) { toast.error(e.message); }
  }

  async function pushToPlex() {
    if (!$selectedPlaylistId) return;
    pushing = true;
    try {
      await api('POST', `/playlists/${$selectedPlaylistId}/push-to-plex`);
      toast.success('Playlist enviada ao Plex!');
    } catch (e) { toast.error(e.message); }
    finally { pushing = false; }
  }

  async function deletePlaylist() {
    if (!$selectedPlaylistId) return;
    if (!confirm('Tem certeza que deseja excluir esta playlist?')) return;
    deleting = true;
    try {
      await api('DELETE', `/playlists/${$selectedPlaylistId}`);
      selectedPlaylistId.set(null);
      detail     = null;
      mobileView = 'list';
      toast.success('Playlist excluída');
      await loadPlaylists();
    } catch (e) { toast.error(e.message); }
    finally { deleting = false; }
  }

  const selectedName = $derived(
    detail?.title ?? detail?.name ?? '—'
  );
</script>

<div class="p-6 w-full min-h-full animate-fade-in">

  <!-- Header — oculto no mobile quando em modo detalhe -->
  {#if !($isMobile && mobileView === 'detail')}
    <div class="flex items-end justify-between gap-4 mb-6">
      <div>
        <h1 class="text-2xl font-extrabold text-white tracking-tight">Playlists</h1>
        <p class="text-sm mt-0.5" style="color:#5a5a78">Gerencie e envie playlists ao Plex</p>
      </div>
      <Button onclick={() => navigate('new-playlist')} size="sm">+ Nova Playlist</Button>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center gap-3 py-10"><Spinner /><span class="text-sm" style="color:#5a5a78">Carregando…</span></div>

  {:else if $isMobile}
    <!-- ── Mobile: navegação empilhada ── -->

    {#if mobileView === 'list'}
      <!-- Lista de playlists em tela cheia -->
      <div class="flex flex-col gap-2">
        {#if $playlists.length === 0}
          <div class="py-12 text-center">
            <div class="text-2xl mb-2">≡</div>
            <div class="text-sm text-white">Nenhuma playlist</div>
            <div class="text-2xs mt-1" style="color:#5a5a78">Crie sua primeira playlist</div>
          </div>
        {:else}
          {#each $playlists as pl}
            {@const isActive = $selectedPlaylistId === (pl.id ?? pl.ratingKey)}
            <button
              class="w-full text-left px-4 py-3.5 rounded-xl border transition-all flex items-center justify-between gap-3"
              style={isActive
                ? 'background:rgba(124,106,245,0.14);border-color:rgba(124,106,245,0.3);color:#fff'
                : 'background:#111118;border-color:#1e1e2e;color:#8888a8'}
              onclick={() => selectPlaylist(pl.id ?? pl.ratingKey)}
            >
              <div class="min-w-0">
                <div class="text-sm font-medium truncate" style={isActive ? 'color:#fff' : ''}>{pl.title ?? pl.name ?? '?'}</div>
                <div class="text-2xs mt-0.5 opacity-70">
                  {pl.tracks?.length ?? pl.leafCount ?? pl.trackCount ?? 0} faixas
                </div>
              </div>
              <span class="shrink-0 text-lg leading-none" style="color:#5a5a78">›</span>
            </button>
          {/each}
        {/if}
      </div>

    {:else}
      <!-- Detalhe de playlist em tela cheia -->
      <div class="rounded-2xl border overflow-hidden flex flex-col" style="background:#111118;border-color:#1e1e2e">

        <!-- Barra superior: voltar + título + ações -->
        <div class="px-4 py-3 border-b flex flex-col gap-3" style="border-color:#1a1a28">

          <!-- Linha 1: botão voltar -->
          <div class="flex items-center gap-2">
            <button
              onclick={goBackToList}
              class="flex items-center gap-1 text-sm font-semibold transition-colors"
              style="color:#7c6af5"
            >
              ‹ Playlists
            </button>
          </div>

          {#if loadingDetail}
            <div class="flex items-center gap-3 py-2"><Spinner /><span class="text-sm" style="color:#5a5a78">Carregando…</span></div>
          {:else if error}
            <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">{error}</div>
          {:else if detail}
            {#if isRenaming}
              <!-- Modo edição de nome -->
              <div class="flex gap-2 items-center">
                <input
                  type="text"
                  bind:value={editName}
                  class="flex-1 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
                  style="background:#16161f;border:1px solid rgba(124,106,245,0.4)"
                  onkeydown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') isRenaming = false; }}
                  autofocus
                />
                <Button size="sm" onclick={saveRename} loading={savingName}>Salvar</Button>
                <Button size="sm" variant="ghost" onclick={() => isRenaming = false}>✕</Button>
              </div>
            {:else}
              <!-- Linha 2: título + ações -->
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="text-base font-semibold text-white truncate">{selectedName}</h2>
                  <div class="text-2xs mt-0.5" style="color:#5a5a78">{(detail.tracks ?? []).length} faixas</div>
                </div>
                <div class="flex gap-1.5 shrink-0">
                  <Button size="sm" variant="ghost" onclick={() => { isRenaming = true; editName = selectedName; }}>Renomear</Button>
                  <Button size="sm" variant="primary" onclick={pushToPlex} loading={pushing}>↑ Plex</Button>
                  <Button size="sm" variant="danger" onclick={deletePlaylist} loading={deleting}>✕</Button>
                </div>
              </div>
            {/if}
          {/if}
        </div>

        <!-- Lista de faixas -->
        {#if detail && !loadingDetail && !error}
          <div class="overflow-y-auto px-4 py-2" style="max-height:calc(100vh - var(--mobile-header-h) - var(--mobile-nav-h) - 10rem)">
            {#if (detail.tracks ?? []).length === 0}
              <div class="py-10 text-center">
                <div class="text-xl mb-2" style="color:#2e2e4a">♪</div>
                <div class="text-sm" style="color:#5a5a78">Playlist vazia</div>
              </div>
            {:else}
              {#each detail.tracks ?? [] as track}
                <TrackRow
                  ratingKey={track.ratingKey}
                  title={track.title}
                  artist={track.grandparentTitle ?? track.artist}
                  album={track.parentTitle ?? track.album}
                  playCount={track.viewCount ?? 0}
                  favorite
                  withRating
                >
                  {#snippet actions()}
                    <Button size="xs" variant="danger" onclick={() => removeTrack(track.ratingKey)}>✕</Button>
                  {/snippet}
                </TrackRow>
              {/each}
            {/if}
          </div>
        {/if}

      </div>
    {/if}

  {:else}
    <!-- ── Desktop: layout 2 painéis lado a lado ── -->
    <div class="flex gap-4" style="height:calc(100vh - 11rem)">

      <!-- Sidebar: lista de playlists -->
      <div class="w-60 shrink-0 flex flex-col gap-1 overflow-y-auto pr-1">
        {#if $playlists.length === 0}
          <div class="py-8 text-center">
            <div class="text-xl mb-2">≡</div>
            <div class="text-sm text-white">Nenhuma playlist</div>
            <div class="text-2xs mt-1" style="color:#5a5a78">Crie sua primeira playlist</div>
          </div>
        {:else}
          {#each $playlists as pl}
            {@const isActive = $selectedPlaylistId === (pl.id ?? pl.ratingKey)}
            <button
              class="w-full text-left px-3 py-2.5 rounded-xl border transition-all"
              style={isActive
                ? 'background:rgba(124,106,245,0.14);border-color:rgba(124,106,245,0.3);color:#fff'
                : 'background:#111118;border-color:#1e1e2e;color:#8888a8'}
              onclick={() => selectPlaylist(pl.id ?? pl.ratingKey)}
            >
              <div class="text-sm font-medium truncate">{pl.title ?? pl.name ?? '?'}</div>
              <div class="text-2xs mt-0.5 opacity-70">
                {pl.tracks?.length ?? pl.leafCount ?? pl.trackCount ?? 0} faixas
              </div>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Painel de detalhe -->
      <div class="flex-1 min-w-0 rounded-2xl border overflow-hidden flex flex-col"
           style="background:#111118;border-color:#1e1e2e">
        {#if !$selectedPlaylistId}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <div class="text-2xl mb-2" style="color:#2e2e4a">←</div>
              <div class="text-sm" style="color:#5a5a78">Selecione uma playlist</div>
            </div>
          </div>
        {:else if loadingDetail}
          <div class="flex-1 flex items-center justify-center gap-3">
            <Spinner /><span class="text-sm" style="color:#5a5a78">Carregando…</span>
          </div>
        {:else if error}
          <div class="p-5">
            <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">{error}</div>
          </div>
        {:else if detail}
          <!-- Cabeçalho da playlist -->
          <div class="px-5 py-4 border-b flex items-center gap-3" style="border-color:#1a1a28">
            <div class="flex-1 min-w-0">
              {#if isRenaming}
                <div class="flex gap-2 items-center">
                  <input
                    type="text"
                    bind:value={editName}
                    class="flex-1 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
                    style="background:#16161f;border:1px solid rgba(124,106,245,0.4)"
                    onkeydown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') isRenaming = false; }}
                    autofocus
                  />
                  <Button size="sm" onclick={saveRename} loading={savingName}>Salvar</Button>
                  <Button size="sm" variant="ghost" onclick={() => isRenaming = false}>✕</Button>
                </div>
              {:else}
                <h2 class="text-base font-semibold text-white truncate">{selectedName}</h2>
                <div class="text-2xs mt-0.5" style="color:#5a5a78">{(detail.tracks ?? []).length} faixas</div>
              {/if}
            </div>
            <div class="flex gap-2 shrink-0">
              <Button size="sm" variant="ghost" onclick={() => { isRenaming = true; editName = selectedName; }}>Renomear</Button>
              <Button size="sm" variant="primary" onclick={pushToPlex} loading={pushing}>↑ Plex</Button>
              <Button size="sm" variant="danger" onclick={deletePlaylist} loading={deleting}>✕</Button>
            </div>
          </div>

          <!-- Lista de faixas -->
          <div class="flex-1 overflow-y-auto px-5 py-2">
            {#if (detail.tracks ?? []).length === 0}
              <div class="py-8 text-center">
                <div class="text-xl mb-2" style="color:#2e2e4a">♪</div>
                <div class="text-sm" style="color:#5a5a78">Playlist vazia</div>
              </div>
            {:else}
              {#each detail.tracks ?? [] as track}
                <TrackRow
                  ratingKey={track.ratingKey}
                  title={track.title}
                  artist={track.grandparentTitle ?? track.artist}
                  album={track.parentTitle ?? track.album}
                  playCount={track.viewCount ?? 0}
                  favorite
                  withRating
                >
                  {#snippet actions()}
                    <Button size="xs" variant="danger" onclick={() => removeTrack(track.ratingKey)}>✕</Button>
                  {/snippet}
                </TrackRow>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

    </div>
  {/if}

</div>
