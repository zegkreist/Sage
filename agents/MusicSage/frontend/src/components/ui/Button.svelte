<script>
  import Spinner from './Spinner.svelte';

  let {
    variant   = 'primary',
    size      = 'md',
    type      = 'button',
    disabled  = false,
    loading   = false,
    class: cls = '',
    onclick,
    children,
    title,
  } = $props();

  const base = 'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-all duration-150 ' +
               'disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 ' +
               'focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-bg';

  const variants = {
    primary:   'bg-accent hover:bg-accent-dim text-white shadow-glow-sm hover:shadow-glow',
    secondary: 'text-soft border border-border-hi hover:border-accent/30 hover:text-white',
    danger:    'text-danger border border-danger/20 hover:bg-danger/10 hover:border-danger/40',
    ghost:     'text-muted hover:text-soft hover:bg-surface3',
    success:   'text-positive border border-positive/20 hover:bg-positive/10',
    accent:    'bg-accent/12 text-accent-hi border border-accent/20 hover:bg-accent/20 hover:border-accent/40',
  };

  const sizes = {
    xs: 'text-2xs px-2 py-1 gap-1',
    sm: 'text-xs px-3 py-1.5',
    md: 'text-sm px-4 py-2',
    lg: 'text-sm px-5 py-2.5',
  };
</script>

<button
  {type} {title}
  class="{base} {variants[variant] ?? variants.primary} {sizes[size] ?? sizes.md} {cls}"
  style={variant === 'secondary' ? 'background: #16161f;' : ''}
  disabled={disabled || loading}
  {onclick}
>
  {#if loading}<Spinner size="xs" />{/if}
  {@render children?.()}
</button>

