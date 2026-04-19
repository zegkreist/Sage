<script>
  let { icon = '📭', title = 'Nada por aqui', subtitle = '', actions, class: cls = '' } = $props();
</script>

<div class="flex flex-col items-center justify-center py-16 text-center gap-3 {cls}">
  <div class="text-5xl opacity-60 select-none">{icon}</div>
  <h3 class="text-sm font-semibold text-dim">{title}</h3>
  {#if subtitle}
    <p class="text-xs text-muted max-w-xs">{subtitle}</p>
  {/if}
  {#if actions}
    <div class="mt-3 flex gap-2">
      {@render actions?.()}
    </div>
  {/if}
</div>
