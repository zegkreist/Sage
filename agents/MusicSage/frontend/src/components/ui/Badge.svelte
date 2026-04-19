<script>
  let { variant = 'default', class: cls = '', children } = $props();

  const variants = {
    default: 'border-border-hi text-muted',
    accent:  'border-accent/25 text-accent-hi',
    success: 'text-positive',
    danger:  'text-danger',
    warn:    'text-amber-400',
    info:    'text-info',
  };

  const bgs = {
    default: '#1c1c28',
    accent:  'rgba(124,106,245,0.1)',
    success: 'rgba(29,185,84,0.1)',
    danger:  'rgba(239,68,68,0.1)',
    warn:    'rgba(245,158,11,0.1)',
    info:    'rgba(56,189,248,0.1)',
  };
</script>

<span
  class="inline-flex items-center px-1.5 py-px rounded-md text-2xs font-semibold border tracking-wide {variants[variant] ?? variants.default} {cls}"
  style="background: {bgs[variant] ?? bgs.default}"
>
  {@render children?.()}
</span>

