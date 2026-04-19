<script>
  import { relTime } from '$lib/utils.js';

  let {
    ratingKey = '',
    title     = '',
    artist    = '',
    album     = '',
    playCount = 0,
    playedAt  = null,
    actions,
    class: cls = '',
  } = $props();

  const subtitle = $derived(
    artist && album ? `${artist} · ${album}` :
    artist          ? artist :
    album           ? album : ''
  );
</script>

<div
  class="list-row flex items-center gap-3 py-2.5 group {cls}"
  data-rating-key={ratingKey}
>
  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium text-white truncate">{title || '—'}</div>
    {#if subtitle}
      <div class="text-2xs truncate" style="color:#8888a8">{subtitle}</div>
    {/if}
  </div>

  {#if playedAt}
    <span class="text-2xs shrink-0" style="color:#5a5a78">{relTime(playedAt)}</span>
  {/if}

  {#if playCount > 0}
    <span class="text-2xs shrink-0 stat-value" style="color:#5a5a78">{playCount}×</span>
  {/if}

  {#if actions}
    <div class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
      {@render actions?.()}
    </div>
  {/if}
</div>
