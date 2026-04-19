<script>
  let { title = '', subtitle = '', class: cls = '', noPad = false, actions, children } = $props();
</script>

<section
  class="rounded-2xl border transition-all duration-200 overflow-hidden {cls}"
  style="background: #111118; border-color: #1a1a28;"
>
  {#if title}
    <div class="flex items-center justify-between px-5 py-4" style="border-bottom: 1px solid #1a1a28;">
      <div>
        <h2 class="text-sm font-semibold text-white tracking-tight">{title}</h2>
        {#if subtitle}
          <p class="text-2xs mt-0.5" style="color:#5a5a78">{subtitle}</p>
        {/if}
      </div>
      {#if actions}
        <div class="flex gap-2 shrink-0">{@render actions?.()}</div>
      {/if}
    </div>
  {/if}
  <div class="{noPad ? '' : 'p-5'}">
    {@render children?.()}
  </div>
</section>

