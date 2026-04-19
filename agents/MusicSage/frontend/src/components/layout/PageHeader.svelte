<script>
  let { title = '', subtitle = '', actions, class: cls = '' } = $props();
</script>

<div class="flex items-start justify-between pb-6 {cls}">
  <div>
    <h1 class="text-2xl font-extrabold text-white tracking-tight leading-none">{title}</h1>
    {#if subtitle}
      <p class="text-sm mt-1.5" style="color:#5a5a78">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex gap-2 shrink-0 mt-0.5">
      {@render actions?.()}
    </div>
  {/if}
</div>

