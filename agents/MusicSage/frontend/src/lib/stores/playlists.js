import { writable } from 'svelte/store';
import { api } from '../api.js';

export const playlists          = writable([]);
export const selectedPlaylistId = writable(null);

export async function loadPlaylists() {
  try {
    const list = await api('GET', '/playlists');
    playlists.set(list ?? []);
    return list;
  } catch (e) {
    console.error('[playlists] load error:', e.message);
    return [];
  }
}
