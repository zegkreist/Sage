<script>
  let { label = '', value = '—', icon = '', delta = null, class: cls = '', accent = false } = $props();

  const deltaClass = $derived(
    delta == null ? '' : delta >= 0 ? 'text-positive' : 'text-danger'
  );
  const deltaText = $derived(
    delta == null ? '' : (delta >= 0 ? `+${delta}` : String(delta))
  );
</script>

<div
  class="relative flex flex-col gap-3 p-5 rounded-2xl border transition-all duration-200 group overflow-hidden
         {accent
           ? 'bg-gradient-card border-accent/20 hover:border-accent/40 hover:shadow-glow-sm'
           : 'border-border hover:border-border-hi'}
         {cls}"
  style="background: #111118;"
>
  <!-- Subtle top-right glow on hover -->
  <div class="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-0 group-hover:opacity-100
              transition-opacity duration-300 pointer-events-none"
    style="background: radial-gradient(circle, rgba(124,106,245,0.12) 0%, transparent 70%)"></div>

  <!-- Icon + label row -->
  <div class="flex items-center justify-between">
    <span class="text-2xs font-semibold uppercase tracking-widest" style="color:#5a5a78">{label}</span>
    {#if icon}
      <span class="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0"
        style="background: rgba(124,106,245,0.1); color: #9d8eff">{icon}</span>
    {/if}
  </div>

  <!-- Value -->
  <div class="text-3xl font-extrabold text-white stat-value leading-none">{value}</div>

  {#if deltaText}
    <div class="text-xs font-medium {deltaClass} flex items-center gap-1">
      <span>{delta >= 0 ? '▲' : '▼'}</span>
      <span>{deltaText} vs mês ant.</span>
    </div>
  {/if}
</div>

