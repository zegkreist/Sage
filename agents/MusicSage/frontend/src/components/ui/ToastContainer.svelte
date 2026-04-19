<script>
  import { fly } from 'svelte/transition';
  import { toast } from '$lib/stores/toast.js';

  const typeStyle = {
    info:    'border-sky-500/40    text-sky-300',
    success: 'border-emerald-500/40 text-emerald-300',
    error:   'border-red-500/40    text-red-300',
    warn:    'border-amber-500/40  text-amber-300',
  };
  const typeIcon = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };
</script>

<div
  class="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 max-w-xs w-full pointer-events-none"
  aria-live="polite"
  aria-atomic="false"
>
  {#each $toast as t (t.id)}
    <div
      transition:fly={{ x: 60, duration: 200 }}
      class="pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-lg
             border bg-surface2 shadow-card text-sm {typeStyle[t.type] ?? typeStyle.info}"
      role="status"
    >
      <span class="shrink-0 mt-0.5" aria-hidden="true">{typeIcon[t.type] ?? 'ℹ️'}</span>
      <span class="flex-1 text-dim">{t.message}</span>
      <button
        class="shrink-0 ml-1 text-current/50 hover:text-current text-base leading-none"
        onclick={() => toast.dismiss(t.id)}
        aria-label="Fechar notificação"
      >×</button>
    </div>
  {/each}
</div>
