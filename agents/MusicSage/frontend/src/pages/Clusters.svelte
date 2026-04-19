<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import { startRenderer3D, startRendererSVG } from '$lib/cluster3d.js';
  import { navigate } from '$lib/stores/router.js';

  import Button      from '../components/ui/Button.svelte';
  import Spinner     from '../components/ui/Spinner.svelte';

  // ─── State ──────────────────────────────────────────────
  let computing     = $state(false);
  let clusterData   = $state(null);  // { clusters, totalAnalyzed }
  let selectedId    = $state(null);
  let mode          = $state('2d');  // '2d' | '3d'
  let errorMsg      = $state('');

  // ─── DOM refs ────────────────────────────────────────────
  let canvas3d;      // bind:this canvas
  let svgEl;         // bind:this SVG
  let dotsGroup;     // bind:this SVG <g>
  let tooltipEl;     // bind:this tooltip div

  // ─── Renderer handles ────────────────────────────────────
  let renderer3d = null;
  let rendererSvg = null;

  onDestroy(() => {
    renderer3d?.stop();
    rendererSvg?.destroy();
  });

  // ─── Compute clusters ────────────────────────────────────
  async function compute() {
    computing = true;
    errorMsg  = '';
    destroyRenderers();
    clusterData  = null;
    selectedId   = null;
    try {
      const data = await api('GET', '/embeddings/clusters-by-analysis?k=auto');
      if (!data?.clusters?.length) {
        errorMsg = 'Nenhuma faixa analisada. Execute a análise de áudio primeiro.';
        return;
      }
      clusterData = data;
      toast(`${data.clusters.length} clusters · ${data.totalAnalyzed ?? '?'} faixas`);
    } catch (e) {
      errorMsg = e.message;
    } finally {
      computing = false;
    }
  }

  function destroyRenderers() {
    renderer3d?.stop();  renderer3d  = null;
    rendererSvg?.destroy(); rendererSvg = null;
  }

  // ─── Render after data arrives / mode changes ─────────────
  $effect(() => {
    if (!clusterData) return;
    // wait for DOM to update (tick)
    setTimeout(() => renderCurrent(), 0);
  });

  $effect(() => {
    const _m = mode;
    if (!clusterData) return;
    setTimeout(() => renderCurrent(), 0);
  });

  function renderCurrent() {
    destroyRenderers();
    if (!clusterData) return;
    if (mode === '3d') {
      if (!canvas3d) return;
      renderer3d = startRenderer3D(canvas3d, clusterData.clusters, {
        tooltip:         tooltipEl,
        onSelectCluster: (id) => { selectedId = id; rendererSvg?.setSelected(id); },
      });
    } else {
      if (!svgEl || !dotsGroup) return;
      rendererSvg = startRendererSVG(svgEl, dotsGroup, clusterData.clusters, {
        tooltip:         tooltipEl,
        onSelectCluster: (id) => { selectedId = id; renderer3d?.setSelected(id); },
      });
    }
  }

  function selectCluster(id) {
    selectedId = id === selectedId ? null : id;
    renderer3d?.setSelected(selectedId);
    rendererSvg?.setSelected(selectedId);
  }

  function resetView() {
    rendererSvg?.resetView();
  }

  // ─── Helpers ─────────────────────────────────────────────
  const selectedCluster = $derived(
    selectedId != null ? (clusterData?.clusters ?? []).find(c => c.id === selectedId) : null
  );

  async function createClusterPlaylist() {
    if (!selectedCluster) return;
    try {
      const pl = await api('POST', '/embeddings/clusters/playlist', {
        clusterId: selectedId,
        clusterData: clusterData,
      });
      toast.success(`Playlist criada: ${pl.title ?? pl.name}`);
      navigate('playlists');
    } catch (e) { toast.error(e.message); }
  }
</script>

<div class="p-6 w-full min-h-full animate-fade-in space-y-5">

  <!-- Header -->
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-extrabold text-white tracking-tight">Clusters</h1>
      <p class="text-sm mt-0.5" style="color:#5a5a78">Agrupamento automático por características de áudio</p>
    </div>
    <Button onclick={compute} loading={computing}>⊛ Calcular</Button>
  </div>

  {#if errorMsg}
    <div class="rounded-xl px-4 py-3 text-sm border" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);color:#ef4444">
      {errorMsg}<button class="ml-2 opacity-60" onclick={() => errorMsg = ''}>✕</button>
    </div>
  {/if}

  {#if !clusterData && !computing}
    <div class="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div class="text-4xl" style="opacity:0.15">⊛</div>
      <div class="text-base font-semibold" style="color:#8888a8">Nenhum cluster calculado</div>
      <p class="text-sm max-w-sm" style="color:#5a5a78">Clique em "Calcular" para agrupar a biblioteca por similaridade de áudio</p>
    </div>
  {/if}

  {#if computing}
    <div class="flex items-center justify-center py-20 gap-3">
      <Spinner />
      <span class="text-sm" style="color:#5a5a78">Calculando clusters (pode demorar)…</span>
    </div>
  {/if}

  {#if clusterData}
    <div class="space-y-4">

      <!-- Toolbar -->
      <div class="flex items-center gap-3 flex-wrap">
        <div class="flex gap-1 p-1 rounded-xl" style="background:#0a0a0f;border:1px solid #1e1e2e">
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={mode === '2d'
              ? 'background:rgba(124,106,245,0.18);color:#9d8eff'
              : 'color:#5a5a78'}
            onclick={() => mode = '2d'}
          >2D Scatter</button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={mode === '3d'
              ? 'background:rgba(124,106,245,0.18);color:#9d8eff'
              : 'color:#5a5a78'}
            onclick={() => mode = '3d'}
          >3D Vista</button>
        </div>
        {#if mode === '2d'}
          <Button size="xs" variant="ghost" onclick={resetView}>↺ Reset</Button>
        {/if}
        <div class="ml-auto text-2xs" style="color:#5a5a78">
          {clusterData.clusters.length} clusters · {clusterData.totalAnalyzed} faixas
        </div>
      </div>

      <!-- Viz + detail -->
      <div class="flex gap-4">

        <!-- Visualization -->
        <div class="flex-1 min-w-0 rounded-2xl border overflow-hidden relative"
             style="height:480px;background:#0d0d14;border-color:#1e1e2e">
          <svg
            bind:this={svgEl}
            id="cl-svg"
            class="absolute inset-0 w-full h-full cursor-grab {mode === '2d' ? '' : 'hidden'}"
            viewBox="0 0 600 480"
            preserveAspectRatio="xMidYMid meet"
          >
            <g class="cl-zoom-group">
              <g bind:this={dotsGroup}></g>
            </g>
          </svg>
          {#if mode === '3d'}
            <canvas bind:this={canvas3d} class="absolute inset-0 w-full h-full cursor-grab"></canvas>
          {/if}
          <div
            bind:this={tooltipEl}
            class="fixed z-50 pointer-events-none rounded-xl px-2.5 py-1.5 text-xs text-white"
            style="display:none;background:#1c1c28;border:1px solid #2e2e4a;max-width:192px"
          ></div>
        </div>

        <!-- Right column -->
        <div class="w-60 shrink-0 flex flex-col gap-3">

          <!-- Legend -->
          <div class="rounded-2xl border p-3" style="background:#111118;border-color:#1e1e2e">
            <div class="text-2xs font-semibold uppercase tracking-wider mb-2.5" style="color:#5a5a78">Clusters</div>
            <div class="space-y-0.5">
              {#each clusterData.clusters as cl}
                <button
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all"
                  style={selectedId === cl.id ? 'background:rgba(124,106,245,0.1)' : ''}
                  onclick={() => selectCluster(cl.id)}
                >
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:{cl.color}"></span>
                  <span class="text-sm text-white flex-1">C{cl.id + 1}</span>
                  <span class="text-2xs" style="color:#5a5a78">{cl.count ?? cl.tracks?.length}</span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Detail -->
          {#if selectedCluster}
            <div class="rounded-2xl border overflow-hidden flex-1 flex flex-col"
                 style="background:#111118;border-color:#1e1e2e">
              <div class="px-3 py-2.5 border-b flex items-center justify-between"
                   style="border-color:#1a1a28">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full" style="background:{selectedCluster.color}"></span>
                  <span class="text-sm font-semibold text-white">Cluster {selectedId + 1}</span>
                </div>
                <div class="flex gap-1">
                  <Button size="xs" onclick={createClusterPlaylist}>+ Playlist</Button>
                  <Button size="xs" variant="ghost" onclick={() => selectCluster(null)}>✕</Button>
                </div>
              </div>
              <div class="overflow-y-auto flex-1 px-3 py-1">
                {#each (selectedCluster.tracks ?? []) as t}
                  <div class="list-row py-1.5">
                    <div class="text-xs font-medium text-white truncate">{t.title ?? '—'}</div>
                    <div class="text-2xs truncate" style="color:#5a5a78">{t.artist ?? ''}</div>
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <div class="rounded-2xl border flex-1 flex items-center justify-center text-center p-4"
                 style="background:#111118;border-color:#1e1e2e">
              <div>
                <div class="text-xl mb-1.5" style="color:#2e2e4a">⊛</div>
                <div class="text-sm" style="color:#5a5a78">Clique em um cluster</div>
              </div>
            </div>
          {/if}

        </div>
      </div>
    </div>
  {/if}

</div>
