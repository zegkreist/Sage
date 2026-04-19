<script>
  let { title = '', subtitle = '', class: cls = '', actions, children } = $props();
</script>

<div class="bg-surface border border-border rounded-xl shadow-card {cls}">
  {#if title || actions}
    <div class="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border/50">
      <div>
        {#if title}
          <h2 class="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {/if}
        {#if subtitle}
          <p class="text-xs text-muted/70 mt-0.5">{subtitle}</p>
        {/if}
      </div>
      {#if actions}
        <div class="flex gap-2 shrink-0">{@render actions?.()}</div>
      {/if}
    </div>
  {/if}
  <div class="p-5">
    {@render children?.()}
  </div>
</div>
