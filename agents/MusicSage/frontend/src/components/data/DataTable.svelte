<script>
  import { escHtml } from '$lib/utils.js';

  let {
    columns      = [],  // Array<{ key, label, class?, render?(val, row): string }>
    rows         = [],
    emptyMessage = 'Nenhum resultado',
    class: cls   = '',
  } = $props();
</script>

<div class="overflow-x-auto {cls}">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-border">
        {#each columns as col}
          <th class="text-left text-xs text-muted uppercase tracking-wider font-medium py-2.5 px-3 whitespace-nowrap {col.class ?? ''}">
            {col.label}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr>
          <td colspan={columns.length} class="text-center py-10 text-muted text-xs">
            {emptyMessage}
          </td>
        </tr>
      {:else}
        {#each rows as row, i (row.id ?? i)}
          <tr class="border-b border-border/40 hover:bg-surface2/50 transition-colors">
            {#each columns as col}
              <td class="py-2 px-3 {col.class ?? ''}">
                {#if col.render}
                  <!-- render() must return pre-escaped HTML -->
                  {@html col.render(row[col.key], row)}
                {:else}
                  {row[col.key] ?? '—'}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>
