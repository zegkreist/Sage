<script>
  let { label = '', value = 0, max = 10, class: cls = '' } = $props();

  const pct   = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
  const color = $derived(
    value >= 7 ? '#1db954' :
    value >= 4 ? '#7c6af5' :
    '#38bdf8'
  );
</script>

<div class="flex items-center gap-3 {cls}">
  <span class="text-xs w-24 shrink-0 truncate" style="color:#5a5a78">{label}</span>
  <div class="flex-1 h-1 rounded-full overflow-hidden" style="background:#1c1c28">
    <div
      class="h-full rounded-full transition-all duration-700"
      style="width:{pct}%; background:{color}; box-shadow: 0 0 6px {color}66"
    ></div>
  </div>
  <span class="text-xs font-bold text-white w-6 text-right shrink-0 stat-value">{value ?? '—'}</span>
</div>

