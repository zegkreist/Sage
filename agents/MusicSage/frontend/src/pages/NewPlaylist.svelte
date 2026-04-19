<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { navigate } from '$lib/stores/router.js';
  import { debounce } from '$lib/utils.js';

  import Button      from '../components/ui/Button.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';

  // ─── Tabs ────────────────────────────────────────────────
  let activeTab = $state('prompt');  // 'prompt' | 'track'

  // ─── Por Prompt ──────────────────────────────────────────
  let prompt        = $state('');
  let maxPerArtist  = $state(3);
  let discoveryRatio = $state(0.2);
  let useRandom     = $state(false);
  let useCache      = $state(true);  // use analysis cache if possible
  let generating    = $state(false);
  let promptResult  = $state(null);
  let promptError   = $state('');

  async function generateFromPrompt() {
    if (!prompt.trim()) { toast.warn('Digite um prompt'); return; }
    generating  = true;
    promptError = '';
    promptResult = null;
    try {
      const endpoint = useCache ? '/playlists/from-cache-prompt' : '/playlists/from-prompt';
      promptResult = await api('POST', endpoint, {
        prompt: prompt.trim(),
        maxPerArtist,
        discoveryRatio,
        random: useRandom,
      });
      toast.success(`Playlist "${promptResult.title ?? promptResult.name}" criada!`);
    } catch (e) {
      promptError = e.message;
    } finally {
      generating = false;
    }
  }

  // ─── Por Música ──────────────────────────────────────────
  let trackQuery    = $state('');
  let trackResults  = $state([]);
  let selectedTrack = $state(null);
  let searching     = $state(false);
  let genTrack      = $state(false);
  let trackResult   = $state(null);
  let trackError    = $state('');

  const searchTracks = debounce(async (q) => {
    if (!q.trim() || q.length < 2) { trackResults = []; return; }
    searching = true;
    try {
      const data = await api('GET', `/library/tracks?q=${encodeURIComponent(q)}&limit=20`);
      trackResults = data?.tracks ?? data ?? [];
    } catch { trackResults = []; }
    finally { searching = false; }
  }, 300);

  $effect(() => { searchTracks(trackQuery); });

  function selectTrack(t) {
    selectedTrack = t;
    trackQuery = `${t.title} — ${t.artist}`;
    trackResults = [];
  }

  async function generateFromTrack() {
    if (!selectedTrack) { toast.warn('Selecione uma faixa âncora'); return; }
    genTrack  = true;
    trackError = '';
    trackResult = null;
    try {
      trackResult = await api('POST', '/playlists/from-cache-track', {
        ratingKey: selectedTrack.ratingKey,
        limit: 30,
      });
      toast.success(`Playlist "${trackResult.title ?? trackResult.name}" criada!`);
    } catch (e) {
      trackError = e.message;
    } finally {
      genTrack = false;
    }
  }
</script>

<div class="p-6 w-full min-h-full animate-fade-in space-y-5">

  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Nova Playlist</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Por prompt ou por música similar</p>
    </div>
    <Button variant="ghost" size="sm" onclick={() => navigate('playlists')}>← Playlists</Button>
  </div>

  <!-- Tab switcher -->
  <div class="flex gap-1 p-1 rounded-xl w-fit" style="background:#0a0a0f;border:1px solid #1e1e2e">
    <button
      class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
      style={activeTab === 'prompt'
        ? 'background:rgba(124,106,245,0.18);color:#9d8eff;border:1px solid rgba(124,106,245,0.25)'
        : 'color:#5a5a78;border:1px solid transparent'}
      onclick={() => activeTab = 'prompt'}
    >Por Prompt</button>
    <button
      class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
      style={activeTab === 'track'
        ? 'background:rgba(124,106,245,0.18);color:#9d8eff;border:1px solid rgba(124,106,245,0.25)'
        : 'color:#5a5a78;border:1px solid transparent'}
      onclick={() => activeTab = 'track'}
    >Por Música</button>
  </div>

  <!-- ── Por Prompt ──────────────────────────────────────── -->
  {#if activeTab === 'prompt'}
    <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
      <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
        <div class="text-sm font-semibold text-white">Gerar por Prompt</div>
      </div>
      <div class="px-5 py-4 space-y-4">

        <div>
          <label class="block text-2xs font-medium mb-1.5" style="color:#5a5a78">Descrição da playlist</label>
          <textarea
            bind:value={prompt}
            rows="3"
            placeholder="Ex: músicas calmas para trabalhar, rock alternativo dos anos 90…"
            class="w-full rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none
                   placeholder:text-[#5a5a78]"
            style="background:#16161f;border:1px solid #1e1e2e"
            onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
            onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
          ></textarea>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="max-per-artist" class="block text-2xs font-medium mb-1.5" style="color:#5a5a78">Máx. faixas por artista</label>
            <input id="max-per-artist" type="number" bind:value={maxPerArtist} min="1" max="20"
              class="w-full rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              style="background:#16161f;border:1px solid #1e1e2e"
              onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
              onblur={e => e.currentTarget.style.borderColor='#1e1e2e'} />
          </div>
          <div>
            <label for="discovery-ratio" class="block text-2xs font-medium mb-1.5" style="color:#5a5a78">Taxa de descoberta (0–1)</label>
            <input id="discovery-ratio" type="number" bind:value={discoveryRatio} min="0" max="1" step="0.05"
              class="w-full rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
              style="background:#16161f;border:1px solid #1e1e2e"
              onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
              onblur={e => e.currentTarget.style.borderColor='#1e1e2e'} />
          </div>
        </div>

        <div class="flex gap-5">
          <label class="flex items-center gap-2 text-sm cursor-pointer select-none" style="color:#8888a8">
            <input type="checkbox" bind:checked={useRandom} class="accent-[#7c6af5]" />
            Ordem aleatória
          </label>
          <label class="flex items-center gap-2 text-sm cursor-pointer select-none" style="color:#8888a8">
            <input type="checkbox" bind:checked={useCache} class="accent-[#7c6af5]" />
            Usar análise de áudio
          </label>
        </div>

        {#if promptError}
          <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">
            {promptError}<button class="ml-2 opacity-60" onclick={() => promptError = ''}>✕</button>
          </div>
        {/if}

        <Button onclick={generateFromPrompt} loading={generating} class="w-full">
          ✦ Gerar Playlist
        </Button>

        {#if promptResult}
          <div class="rounded-xl px-4 py-3 border" style="background:rgba(29,185,84,0.08);border-color:rgba(29,185,84,0.2)">
            <div class="text-sm font-semibold" style="color:#1db954">
              "{promptResult.title ?? promptResult.name}" criada com {promptResult.trackCount ?? promptResult.tracks?.length ?? '?'} faixas
            </div>
            <button class="text-2xs underline mt-1" style="color:#9d8eff" onclick={() => navigate('playlists')}>Ver playlists →</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Por Música ──────────────────────────────────────── -->
  {#if activeTab === 'track'}
    <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
      <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
        <div class="text-sm font-semibold text-white">Playlist Radio (por similaridade)</div>
      </div>
      <div class="px-5 py-4 space-y-4">

        <div class="relative">
          <label for="track-search" class="block text-2xs font-medium mb-1.5" style="color:#5a5a78">Faixa âncora</label>
          <div class="relative">
            <input
              id="track-search"
              type="text"
              bind:value={trackQuery}
              placeholder="Buscar faixa…"
              class="w-full rounded-lg px-3 py-2 text-sm text-white focus:outline-none
                     placeholder:text-[#5a5a78]"
              style="background:#16161f;border:1px solid #1e1e2e"
              onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
              onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
              oninput={() => { selectedTrack = null; }}
            />
            {#if searching}
              <div class="absolute right-3 top-1/2 -translate-y-1/2"><Spinner size="xs" /></div>
            {/if}
          </div>

          {#if trackResults.length > 0}
            <div class="absolute z-10 w-full mt-1 rounded-xl border shadow-xl overflow-hidden max-h-48 overflow-y-auto"
                 style="background:#1c1c28;border-color:#2e2e4a">
              {#each trackResults as t}
                <button
                  class="list-row w-full text-left px-3 py-2 transition-colors"
                  onclick={() => selectTrack(t)}
                >
                  <div class="text-sm text-white truncate">{t.title}</div>
                  <div class="text-2xs truncate" style="color:#5a5a78">{[t.artist, t.album].filter(Boolean).join(' · ')}</div>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        {#if selectedTrack}
          <div class="rounded-xl px-3 py-2 border text-sm" style="background:rgba(124,106,245,0.08);border-color:rgba(124,106,245,0.2)">
            <span style="color:#9d8eff">Âncora:</span>
            <span class="text-white ml-1">{selectedTrack.title}</span>
            <span class="ml-1" style="color:#5a5a78">— {selectedTrack.artist}</span>
          </div>
        {/if}

        {#if trackError}
          <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">
            {trackError}<button class="ml-2 opacity-60" onclick={() => trackError = ''}>✕</button>
          </div>
        {/if}

        <Button onclick={generateFromTrack} loading={genTrack} class="w-full" disabled={!selectedTrack}>
          ♪ Gerar Radio
        </Button>

        {#if trackResult}
          <div class="rounded-xl px-4 py-3 border" style="background:rgba(29,185,84,0.08);border-color:rgba(29,185,84,0.2)">
            <div class="text-sm font-semibold" style="color:#1db954">
              "{trackResult.title ?? trackResult.name}" criada com {trackResult.trackCount ?? trackResult.tracks?.length ?? '?'} faixas
            </div>
            <button class="text-2xs underline mt-1" style="color:#9d8eff" onclick={() => navigate('playlists')}>Ver playlists →</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

</div>
