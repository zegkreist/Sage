import { writable, get as getStore } from 'svelte/store';
import { api } from '../api.js';

/**
 * Curadoria pessoal — espelha GET/PUT/DELETE /api/favorites.
 *
 * A chave tem que ser idêntica à do FavoritesService no backend
 * (src/services/FavoritesService.js), senão o coração pisca e volta.
 */
export const favorites = writable(new Map()); // key → { artist, title, album, starred, rating }

export function favKey(artist = '', title = '', album = '') {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [norm(artist), norm(title), norm(album)].join('|');
}

export async function loadFavorites() {
  try {
    const data = await api('GET', '/favorites');
    const map = new Map();
    for (const f of data?.favorites ?? []) map.set(favKey(f.artist, f.title, f.album), f);
    favorites.set(map);
    return map;
  } catch (e) {
    console.error('[favorites] load error:', e.message);
    return getStore(favorites);
  }
}

export function getFavorite(artist, title, album) {
  return getStore(favorites).get(favKey(artist, title, album)) ?? null;
}

/**
 * Aplica o patch localmente antes do request (otimista) e reverte se o
 * servidor recusar — favoritar é ação de um clique, esperar round-trip trava a lista.
 * @param {{artist?: string, title?: string, album?: string, ratingKey?: string}} track
 * @param {{starred?: boolean, rating?: number|null}} patch
 * @returns {Promise<{favorite: object|null, mediaServer?: {synced: boolean, reason?: string}}|null>}
 */
export async function setFavorite(track, patch) {
  const key  = favKey(track.artist, track.title, track.album);
  const prev = getStore(favorites).get(key) ?? null;

  const optimistic = {
    artist: track.artist ?? '', title: track.title ?? '', album: track.album ?? '',
    ratingKey: track.ratingKey || prev?.ratingKey || null,
    starred: typeof patch.starred === 'boolean' ? patch.starred : (prev?.starred ?? false),
    rating:  patch.rating !== undefined ? patch.rating : (prev?.rating ?? null),
  };
  // Sem estrela e sem nota → o backend apaga; espelha isso aqui
  const cleared = !optimistic.starred && optimistic.rating == null;
  favorites.update((m) => {
    const next = new Map(m);
    if (cleared) next.delete(key); else next.set(key, optimistic);
    return next;
  });

  try {
    const res = await api('PUT', '/favorites', { ...track, ...patch });
    favorites.update((m) => {
      const next = new Map(m);
      if (res?.favorite) next.set(key, res.favorite); else next.delete(key);
      return next;
    });
    // Devolve a resposta inteira: quem chama precisa saber se a nota chegou no servidor
    return res ?? null;
  } catch (e) {
    favorites.update((m) => {
      const next = new Map(m);
      if (prev) next.set(key, prev); else next.delete(key);
      return next;
    });
    throw e;
  }
}
