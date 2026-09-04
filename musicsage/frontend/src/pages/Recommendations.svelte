<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, pollJob } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { navigate, navigateToDownload } from '$lib/stores/router.js';

  import Button  from '../components/ui/Button.svelte';
  import Spinner from '../components/ui/Spinner.svelte';

  // ─── Recomendações por perfil ─────────────────────────────
  let recs        = $state(null);
  let loadingRecs = $state(true);

  // ─── Recomendações por prompt ─────────────────────────────
  let promptQuery   = $state('');
  let promptRecs    = $state(null);   // null | []
  let loadingPrompt = $state(false);
  let promptStage   = $state('');
  let promptPct     = $state(0);

  // ─── Artistas Similares ───────────────────────────────────
  let similar     = $state(null);
  let artistQuery = $state('');
  let inLibOnly   = $state(false);
  let loadingSim  = $state(false);

  // ─── Autocomplete de artista ──────────────────────────────
  let suggestions = $state([]);
  let showSugg    = $state(false);
  let activeSugg  = $state(-1);
  let _suggTimer  = null;
  let _inputEl    = $state(null);
  let _dropStyle  = $state('');

  onMount(loadRecs);
  onDestroy(() => clearTimeout(_suggTimer));

  // ── Perfil ──────────────────────────────────────────────────
  async function loadRecs() {
    loadingRecs = true;
    try {
      const list = await api('GET', '/recommendations');
      const artists = (Array.isArray(list) ? list : (list?.artists ?? [])).map(r => ({
        name:           r.name   ?? r.artist ?? '?',
        genre:          r.genre  ?? '',
        whyRecommended: r.whyRecommended ?? '',
        inLibrary:      r.inLibrary ?? false,
      }));
      recs = { artists, tracks: list?.tracks ?? [] };
    } catch (e) { toast.error(`Recomendações: ${e.message}`); }
    finally { loadingRecs = false; }
  }

  // ── Por Prompt ──────────────────────────────────────────────
  async function generatePromptRecs() {
    if (!promptQuery.trim()) return;
    loadingPrompt = true;
    promptRecs    = null;
    promptStage = 'Enviando pedido…'; promptPct = 0;
    try {
      const started = await api('POST', '/recommendations/by-prompt', {
        prompt: promptQuery.trim(),
        limit:  10,
        async: true,
      }, { timeoutMs: 30_000 });
      const list = await pollJob(started.jobId, (stage, pct) => { promptStage = stage; promptPct = pct; });
      promptRecs = (Array.isArray(list) ? list : []).map(r => ({
        name:           r.name   ?? r.artist ?? '?',
        genre:          r.genre  ?? '',
        whyRecommended: r.whyRecommended ?? r.why ?? '',
      }));
    } catch (e) { toast.error(e.message); }
    finally { loadingPrompt = false; promptStage = ''; promptPct = 0; }
  }

  // ── Similares ───────────────────────────────────────────────
  async function searchSimilar() {
    if (!artistQuery.trim()) return;
    loadingSim = true;
    similar    = null;
    showSugg   = false;
    try {
      const endpoint = inLibOnly
        ? `/recommendations/similar-in-library?artist=${encodeURIComponent(artistQuery)}&limit=10`
        : `/recommendations/similar?artist=${encodeURIComponent(artistQuery)}&limit=10`;
      const list = await api('GET', endpoint);
      similar = (Array.isArray(list) ? list : (list?.artists ?? [])).map(r => ({
        name:      r.name   ?? r.artist ?? '?',
        genre:     r.genre  ?? '',
        inLibrary: r.inLibrary ?? false,
      }));
    } catch (e) { toast.error(e.message); }
    finally { loadingSim = false; }
  }

  async function createPlaylistFromArtist(artist) {
    try {
      toast(`Gerando playlist de ${artist}…`);
      const started = await api('POST', '/playlists/from-prompt', {
        prompt: `Músicas do artista ${artist} que estão na minha biblioteca`,
        maxPerArtist: 5,
        async: true,
      }, { timeoutMs: 30_000 });
      const pl = await pollJob(started.jobId);
      toast.success(`Playlist "${pl.title ?? pl.name}" criada!`);
      navigate('playlists');
    } catch (e) { toast.error(e.message); }
  }

  // ── Autocomplete de artista ──────────────────────────────────
  function _updateDropPos() {
    if (!_inputEl) return;
    const r = _inputEl.getBoundingClientRect();
    // position:fixed escapa qualquer overflow:hidden pai
    _dropStyle = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.bottom) + 4}px;width:${Math.round(r.width)}px;z-index:9999`;
  }

  async function fetchSuggestions(q) {
    if (q.length < 2) { suggestions = []; showSugg = false; return; }
    try {
      // Usa endpoint dedicado de artistas — retorna todos os artistas da biblioteca que contenham q
      const data = await api('GET', `/library/artists?q=${encodeURIComponent(q)}&limit=10`);
      suggestions = (data?.artists ?? []).map(a => a.name);
      showSugg    = suggestions.length > 0;
      activeSugg  = -1;
      _updateDropPos();
    } catch { suggestions = []; showSugg = false; }
  }

  function onArtistInput(e) {
    artistQuery = e.target.value;
    clearTimeout(_suggTimer);
    _suggTimer = setTimeout(() => fetchSuggestions(artistQuery), 200);
  }

  function selectSuggestion(name) {
    artistQuery = name;
    showSugg    = false;
    suggestions = [];
    searchSimilar();
  }

  function onArtistKeydown(e) {
    if (!showSugg) { if (e.key === 'Enter') searchSimilar(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSugg = Math.min(activeSugg + 1, suggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSugg = Math.max(activeSugg - 1, -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSugg >= 0 && suggestions[activeSugg]) selectSuggestion(suggestions[activeSugg]);
      else { showSugg = false; searchSimilar(); }
    } else if (e.key === 'Escape') {
      showSugg = false; activeSugg = -1;
    }
  }

  // Delay para deixar o mousedown da sugestão registrar antes do blur fechar o dropdown
  function onArtistBlur() {
    setTimeout(() => { showSugg = false; activeSugg = -1; }, 150);
  }

  function onArtistFocus(e) {
    e.currentTarget.style.borderColor = 'rgba(124,106,245,0.4)';
    _updateDropPos();
    if (suggestions.length > 0) showSugg = true;
  }
</script>

<div class="p-6 w-full min-h-full space-y-7 animate-fade-in">

  <!-- ── Header ──────────────────────────────────────────────── -->
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Recomendações</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Descubra artistas baseados no seu gosto ou no seu pedido</p>
    </div>
    <Button size="xs" variant="ghost" onclick={loadRecs} title="Atualizar perfil">↻</Button>
  </div>

  <!-- ── Por Prompt ──────────────────────────────────────────── -->
  <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
    <div class="px-5 py-4 border-b flex items-center gap-2" style="border-color:#1a1a28">
      <span class="text-sm font-semibold text-white">Por Pedido</span>
      <span class="text-2xs px-1.5 py-0.5 rounded font-medium"
            style="background:rgba(124,106,245,0.12);color:#9d8eff">IA + Last.fm</span>
    </div>
    <div class="px-5 py-4">
      <div class="flex gap-2">
        <input
          type="text"
          bind:value={promptQuery}
          placeholder='Ex: "rock pesado para treinar", "jazz melancólico para trabalhar tarde"…'
          class="flex-1 rounded-lg px-3 py-2 text-sm text-white transition-colors placeholder:text-[#3a3a58] focus:outline-none"
          style="background:#16161f;border:1px solid #1e1e2e"
          onfocus={e => e.currentTarget.style.borderColor='rgba(124,106,245,0.4)'}
          onblur={e => e.currentTarget.style.borderColor='#1e1e2e'}
          onkeydown={e => e.key === 'Enter' && generatePromptRecs()}
        />
        <Button onclick={generatePromptRecs} loading={loadingPrompt} size="sm"
                disabled={!promptQuery.trim()}>Gerar</Button>
      </div>
      <p class="text-2xs mt-2" style="color:#3a3a58">
        A IA gera sugestões; cada artista é verificado no Last.fm antes de aparecer
      </p>

      {#if loadingPrompt}
        <div class="mt-5 py-4">
          <div class="flex items-center gap-2">
            <Spinner size="sm" />
            <span class="text-2xs" style="color:#9d8eff">{promptStage || 'Gerando…'}</span>
            <span class="text-2xs ml-auto" style="color:#5a5a78">{promptPct}%</span>
          </div>
          <div class="h-1.5 rounded-full overflow-hidden mt-2" style="background:#1a1a28">
            <div class="h-full rounded-full transition-all duration-500" style="width:{promptPct}%;background:linear-gradient(90deg,#7c6af5,#9d8eff)"></div>
          </div>
        </div>
      {:else if promptRecs !== null}
        {#if promptRecs.length === 0}
          <div class="mt-5 py-4 text-center text-sm" style="color:#5a5a78">
            Nenhum artista validado encontrado. Tente reformular o pedido.
          </div>
        {:else}
          <div class="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each promptRecs as artist, i}
              <div class="rounded-xl p-3 border group transition-all"
                   style="background:#16161f;border-color:#1e1e2e">
                <div class="flex items-start gap-2">
                  <span class="rank-chip mt-0.5 shrink-0 {i===0?'top1':i===1?'top2':i===2?'top3':''}">{i+1}</span>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="text-sm font-medium text-white truncate">{artist.name}</span>
                      {#if artist.genre}
                        <span class="text-2xs px-1.5 py-0.5 rounded shrink-0"
                              style="background:rgba(124,106,245,0.12);color:#9d8eff">{artist.genre}</span>
                      {/if}
                    </div>
                    {#if artist.whyRecommended}
                      <p class="text-2xs mt-1 leading-relaxed" style="color:#8888a8">{artist.whyRecommended}</p>
                    {/if}
                  </div>
                </div>
                <div class="actions-reveal flex gap-1 mt-2">
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs"
                          style="background:rgba(56,189,248,0.1);color:#38bdf8"
                          title="TideCaller" onclick={() => navigateToDownload('tidecaller', artist.name)}>∿</button>
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs"
                          style="background:rgba(245,158,11,0.1);color:#f59e0b"
                          title="Stormbringer" onclick={() => navigateToDownload('stormbringer', artist.name)}>↯</button>
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs"
                          style="background:rgba(124,106,245,0.1);color:#9d8eff"
                          title="Criar playlist" onclick={() => createPlaylistFromArtist(artist.name)}>+</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- ── Recomendações por perfil ────────────────────────────── -->
  {#if loadingRecs}
    <div class="flex items-center gap-3 py-10">
      <Spinner />
      <span class="text-sm" style="color:#5a5a78">Analisando seu perfil musical…</span>
    </div>
  {:else if recs}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">

      <!-- Artistas Recomendados -->
      <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
        <div class="flex items-center justify-between px-5 py-4 border-b" style="border-color:#1a1a28">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-white">Baseado no seu perfil</span>
          </div>
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
                    <div class="text-sm font-medium text-white truncate">{artist.name}</div>
                    {#if artist.genre}
                      <span class="text-2xs px-1.5 py-0.5 rounded font-medium shrink-0"
                            style="background:rgba(124,106,245,0.12);color:#9d8eff">{artist.genre}</span>
                    {/if}
                  </div>
                  {#if artist.whyRecommended}
                    <div class="text-2xs mt-1 leading-relaxed" style="color:#8888a8">{artist.whyRecommended}</div>
                  {/if}
                </div>
                {#if artist.inLibrary}
                  <span class="text-2xs px-2 py-0.5 rounded font-medium shrink-0"
                        style="background:rgba(29,185,84,0.12);color:#1db954">Na biblioteca</span>
                {:else}
                  <span class="text-2xs px-2 py-0.5 rounded font-medium shrink-0"
                        style="background:rgba(88,88,120,0.2);color:#5a5a78">Fora</span>
                {/if}
                <div class="actions-reveal flex gap-1 shrink-0">
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                          style="background:rgba(56,189,248,0.1);color:#38bdf8"
                          title="TideCaller" onclick={() => navigateToDownload('tidecaller', artist.name)}>∿</button>
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                          style="background:rgba(245,158,11,0.1);color:#f59e0b"
                          title="Stormbringer" onclick={() => navigateToDownload('stormbringer', artist.name)}>↯</button>
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs transition-colors"
                          style="background:rgba(124,106,245,0.1);color:#9d8eff"
                          title="Criar playlist" onclick={() => createPlaylistFromArtist(artist.name)}>+</button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Faixas Recomendadas -->
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

  <!-- ── Artistas Similares ───────────────────────────────────── -->
  <div class="rounded-2xl border overflow-hidden" style="background:#111118;border-color:#1e1e2e">
    <div class="px-5 py-4 border-b" style="border-color:#1a1a28">
      <div class="text-sm font-semibold text-white">Artistas Similares</div>
      <div class="text-2xs mt-0.5" style="color:#5a5a78">Encontre artistas parecidos com quem você ouve</div>
    </div>
    <div class="px-5 py-4">

      <!-- Input + autocomplete -->
      <div class="flex gap-2 mb-4">
        <input
          bind:this={_inputEl}
          type="text"
          value={artistQuery}
          placeholder="Nome do artista…"
          class="flex-1 rounded-lg px-3 py-2 text-sm text-white transition-colors
                 placeholder:text-[#5a5a78] focus:outline-none"
          style="background:#16161f;border:1px solid #1e1e2e"
          oninput={onArtistInput}
          onfocus={onArtistFocus}
          onblur={e => { e.currentTarget.style.borderColor='#1e1e2e'; onArtistBlur(); }}
          onkeydown={onArtistKeydown}
        />

        <!-- Dropdown com position:fixed — escapa qualquer overflow:hidden pai -->
        {#if showSugg && suggestions.length > 0}
          <div style="{_dropStyle};background:#16161f;border:1px solid #2a2a3a;border-radius:0.75rem;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,0.7)">
            {#each suggestions as s, idx}
              <button
                class="w-full text-left px-3 py-2.5 text-sm transition-colors"
                style={idx === activeSugg
                  ? 'background:rgba(124,106,245,0.2);color:#e0e0f0'
                  : 'color:#b0b0c8;background:transparent'}
                onmousedown={(e) => { e.preventDefault(); selectSuggestion(s); }}
              >{s}</button>
            {/each}
          </div>
        {/if}

        <label class="flex items-center gap-1.5 cursor-pointer text-2xs shrink-0" style="color:#5a5a78">
          <input type="checkbox" bind:checked={inLibOnly} class="accent-[#7c6af5] w-3 h-3" />
          Na biblioteca
        </label>
        <Button onclick={searchSimilar} loading={loadingSim} size="sm">Buscar</Button>
      </div>

      {#if loadingSim}
        <div class="flex items-center gap-2 py-4">
          <Spinner size="sm" />
          <span class="text-2xs" style="color:#5a5a78">Buscando…</span>
        </div>
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
                <div class="actions-reveal flex gap-1 mt-2">
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs"
                          style="background:rgba(56,189,248,0.1);color:#38bdf8"
                          title="TideCaller" onclick={() => navigateToDownload('tidecaller', a.name)}>∿</button>
                  <button class="w-6 h-6 rounded flex items-center justify-center text-xs"
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
