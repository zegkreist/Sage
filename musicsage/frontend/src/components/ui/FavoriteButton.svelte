<script>
  import { favorites, favKey, setFavorite } from '$lib/stores/favorites.js';
  import { toast } from '$lib/stores/toast.js';

  let {
    artist = '',
    title  = '',
    album  = '',
    withRating = false,   // mostra as 5 estrelas ao lado do coração
    class: cls = '',
  } = $props();

  const key     = $derived(favKey(artist, title, album));
  const entry   = $derived($favorites.get(key) ?? null);
  const starred = $derived(!!entry?.starred);
  const rating  = $derived(entry?.rating ?? null);

  let busy = $state(false);

  async function apply(patch) {
    if (busy) return;
    busy = true;
    try {
      await setFavorite({ artist, title, album }, patch);
    } catch (e) {
      toast.error(`Não consegui salvar o favorito: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  const toggleStar = () => apply({ starred: !starred });
  // Clicar na nota atual limpa — senão não há como desfazer um 3/5
  const rate = (n) => apply({ rating: rating === n ? null : n });
</script>

<span class="inline-flex items-center gap-1 {cls}" class:opacity-50={busy}>
  <button
    type="button"
    class="leading-none transition-colors text-sm"
    style="color: {starred ? '#ef4444' : '#5a5a78'}"
    aria-pressed={starred}
    aria-label={starred ? `Desfavoritar ${title || artist}` : `Favoritar ${title || artist}`}
    title={starred ? 'Remover dos favoritos' : 'Favoritar'}
    onclick={toggleStar}
  >{starred ? '♥' : '♡'}</button>

  {#if withRating}
    <span class="inline-flex items-center" role="group" aria-label="Nota de 1 a 5">
      {#each [1, 2, 3, 4, 5] as n}
        <button
          type="button"
          class="leading-none text-2xs px-px transition-colors"
          style="color: {rating != null && n <= rating ? '#f5c518' : '#3a3a52'}"
          aria-label={`Dar nota ${n}`}
          title={rating === n ? 'Clique para limpar a nota' : `Nota ${n}/5`}
          onclick={() => rate(n)}
        >★</button>
      {/each}
    </span>
  {/if}
</span>
