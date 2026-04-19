<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { navigate } from '$lib/stores/router.js';
  import { navigateToDownload } from '$lib/stores/router.js';

  import Button      from '../components/ui/Button.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';

  let recs        = $state(null);   // { artists: [...], tracks: [] }
  let similar     = $state(null);   // for similar-in-library
  let artistQuery = $state('');
  let inLibOnly   = $state(false);
  let loadingRecs = $state(true);
  let loadingSim  = $state(false);

  onMount(loadRecs);

  async function loadRecs() {
    loadingRecs = true;
    try {
      const list = await api('GET', '/recommendations');
      // API returns flat array [{artist, genre, whyRecommended}] — normalize to expected shape
      const artists = (Array.isArray(list) ? list : (list?.artists ?? [])).map(r => ({
        name:            r.name   ?? r.artist ?? r.title ?? '?',
        genre:           r.genre  ?? '',
        whyRecommended:  r.whyRecommended ?? '',
        inLibrary:       r.inLibrary ?? false,
      }));
      recs = { artists, tracks: list?.tracks ?? [] };
    }
    catch (e) { toast.error(`Recomendações: ${e.message}`); }
    finally { loadingRecs = false; }
  }

  async function searchSimilar() {
    if (!artistQuery.trim()) return;
    loadingSim = true;
    similar = null;
    try {
      const endpoint = inLibOnly
        ? `/recommendations/similar-in-library?artist=${encodeURIComponent(artistQuery)}&limit=10`
        : `/recommendations/similar?artist=${encodeURIComponent(artistQuery)}&limit=10`;
      const list = await api('GET', endpoint);
      // Normalize: API returns [{artist, genre, whyRecommended, inLibrary?}]
      similar = (Array.isArray(list) ? list : (list?.artists ?? [])).map(r => ({
        name:      r.name   ?? r.artist ?? r.title ?? '?',
        genre:     r.genre  ?? '',
        inLibrary: r.inLibrary ?? false,
      }));
    } catch (e) { toast.error(e.message); }
    finally { loadingSim = false; }
  }

  async function createPlaylistFromArtist(artist) {
    try {
      const pl = await api('POST', '/playlists/from-prompt', {
        prompt: `Músicas do artista ${artist} que estão na minha biblioteca`,
        maxPerArtist: 5,
      });
      toast.success(`Playlist "${pl.title ?? pl.name}" criada!`);
      navigate('playlists');
    } catch (e) { toast.error(e.message); }
  }
</script>

<div class="p-6 w-full min-h-full space-y-7 animate-fade-in">

  <!-- Header -->
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Recomendações</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Artistas e faixas baseados no seu gosto musical</p>
    </div>
    <Button size="xs" variant="ghost" onclick={loadRecs} title="Atualizar">↻</Button>
  </div>

  <!-- Main recommendations -->
  {#if loadingRecs}
    <div class="flex items-center gap-3 py-12">
      <Spinner />
      <span class="text-sm" style="color:#5a5a78">Analisando seu perfil musical…</span>
    </div>
  {:else if recs}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">

      <!-- Recommended artists -->
      <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
        <div class="flex items-center justify-between px-5 py-4 border-b" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Artistas Recomendados</div>
          <span class="text-2xs" style="color:#5a5a78">{(recs.artists ?? []).length} artistas</span>
        </div>
        <div class="px-3 py-2">
          {#if (recs.artists ?? []).length === 0}
            <div class="py-8 text-center text-sm" style="color:#5a5a78">Nenhum artista recomendado</div>
          {:else}
            {#each recs.artists ?? [] as artist, i}
              <div class="list-row flex items-start gap-3 py-2.5 group">
                <span class="rank-chip mt-0.5 {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <div class="text-sm font-medium text-white truncate">{artist.name ?? artist.title ?? '?'}</div>
                    {#if artist.genre}
                      <span class="text-2xs px-1.5 py-0.5 rounded font-medium shrink-0" style="background:rgba(124,106,245,0.12);color:#9d8eff">{artist.genre}</span>
                    {/if}
                  </div>
                  {#if artist.whyRecommended}
                    <div class="text-2xs mt-1 leading-relaxed" style="color:#8888a8">{artist.whyRecommended}</div>
                  {/if}
                </div>
                {#if artist.inLibrary}
                  <span class="text-2xs px-2 py-0.5 rounded font-medium" style="background:rgba(29,185,84,0.12);color:#1db954">Na biblioteca</span>
                {:else}
                  <span class="text-2xs px-2 py-0.5 rounded font-medium" style="background:rgba(88,88,120,0.2);color:#5a5a78">Fora</span>
                {/if}
                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                    style="background:rgba(56,189,248,0.1);color:#38bdf8"
                    title="Buscar no TideCaller (Tidal)"
                    onclick={() => navigateToDownload('tidecaller', artist.name)}
                  >∿</button>
                  <button
                    class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                    style="background:rgba(245,158,11,0.1);color:#f59e0b"
                    title="Buscar no Stormbringer (Torrent)"
                    onclick={() => navigateToDownload('stormbringer', artist.name)}
                  >↯</button>
                  <button
                    class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                    style="background:rgba(124,106,245,0.1);color:#9d8eff"
                    title="Criar playlist"
                    onclick={() => createPlaylistFromArtist(artist.name ?? artist.title)}
                  >+</button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Recommended tracks -->
      <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
        <div class="flex items-center justify-between px-5 py-4 border-b" style="border-color:#1a1a28">
          <div class="text-sm font-semibold text-white">Faixas Recomendadas</div>
          <span class="text-2xs" style="color:#5a5a78">{(recs.tracks ?? []).length} faixas</span>
        </div>
        <div class="px-3 py-2">
          {#if (recs.tracks ?? []).length === 0}
            <div class="py-8 text-center text-sm" style="color:#5a5a78">Nenhuma faixa nesta sessão</div>
          {:else}
            {#each recs.tracks ?? [] as track, i}
              <div class="list-row flex items-center gap-3 py-2.5">
                <span class="rank-chip {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-white truncate">{track.title ?? '?'}</div>
                  <div class="text-2xs truncate" style="color:#5a5a78">{[track.artist, track.album].filter(Boolean).join(' · ')}</div>
                </div>
                {#if track.inLibrary}
                  <span class="text-2xs font-bold" style="color:#1db954">✓</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>

    </div>
  {/if}

  <!-- Similar artist search -->
  <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
    <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
      <div class="text-sm font-semibold text-white">Artistas Similares</div>
      <div class="text-2xs mt-0.5" style="color:#5a5a78">Encontre artistas parecidos com quem você ouve</div>
    </div>
    <div class="px-5 py-4">
      <div class="flex gap-2 mb-4">
        <input
          type="text"
          bind:value={artistQuery}
          placeholder="Nome do artista…"
          class="flex-1 rounded-lg px-3 py-2 text-sm text-white transition-colors
                 placeholder:text-[#5a5a78] focus:outline-none"
          style="background:#16161f;border:1px solid #1e1e2e"
          onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
          onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
          onkeydown={e => e.key === 'Enter' && searchSimilar()}
        />
        <label class="flex items-center gap-1.5 cursor-pointer text-2xs shrink-0" style="color:#5a5a78">
          <input type="checkbox" bind:checked={inLibOnly} class="accent-[#7c6af5] w-3 h-3" />
          Na biblioteca
        </label>
        <Button onclick={searchSimilar} loading={loadingSim} size="sm">Buscar</Button>
      </div>

      {#if loadingSim}
        <div class="flex items-center gap-2 py-4"><Spinner size="sm" /><span class="text-2xs" style="color:#5a5a78">Buscando…</span></div>
      {:else if similar}
        {#if similar.length === 0}
          <div class="py-6 text-center text-sm" style="color:#5a5a78">Nenhum resultado — tente outro artista</div>
        {:else}
          <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {#each similar as a}
              <div class="rounded-xl p-3 border transition-all group"
                   style="background:#16161f;border-color:#1e1e2e">
                <div class="text-sm font-medium text-white truncate">{a.name}</div>
                {#if a.genre}
                  <div class="text-2xs truncate mt-0.5" style="color:#5a5a78">{a.genre}</div>
                {/if}
                {#if a.inLibrary}
                  <div class="text-2xs mt-1 font-medium" style="color:#1db954">Na biblioteca</div>
                {/if}
                <div class="flex gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    class="w-6 h-6 rounded flex items-center justify-center text-xs"
                    style="background:rgba(56,189,248,0.1);color:#38bdf8"
                    title="TideCaller" onclick={() => navigateToDownload('tidecaller', a.name)}>∿</button>
                  <button
                    class="w-6 h-6 rounded flex items-center justify-center text-xs"
                    style="background:rgba(245,158,11,0.1);color:#f59e0b"
                    title="Torrent" onclick={() => navigateToDownload('stormbringer', a.name)}>↯</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>

</div>
