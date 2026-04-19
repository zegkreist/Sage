<script>
  let { type = 'info', message = '', onDismiss, class: cls = '' } = $props();

  const styles = {
    info:    ['border-sky-500/30    bg-sky-500/10    text-sky-300',     'ℹ️'],
    success: ['border-emerald-500/30 bg-emerald-500/10 text-emerald-300', '✅'],
    error:   ['border-red-500/30    bg-red-500/10    text-red-300',     '❌'],
    warn:    ['border-amber-500/30  bg-amber-500/10  text-amber-300',   '⚠️'],
  };

  const [cls2, icon] = $derived(styles[type] ?? styles.info);
</script>

{#if message}
  <div
    class="flex items-start gap-2 px-3 py-2.5 rounded-lg border text-sm {cls2} {cls}"
    role="alert"
  >
    <span aria-hidden="true" class="shrink-0 mt-0.5">{icon}</span>
    <span class="flex-1">{message}</span>
    {#if onDismiss}
      <button
        class="shrink-0 text-current/60 hover:text-current ml-auto text-lg leading-none"
        onclick={onDismiss}
        aria-label="Fechar"
      >×</button>
    {/if}
  </div>
{/if}
