import { writable } from 'svelte/store';
import { api } from '../api.js';

export const libraryStats   = writable(null);
export const libraryTracks  = writable([]);   // full track list for autocomplete

export async function loadLibraryStats() {
  try {
    const stats = await api('GET', '/library/stats');
    libraryStats.set(stats);
    return stats;
  } catch (e) {
    console.error('[library] stats error:', e.message);
    return null;
  }
}

export async function loadLibraryTracks() {
  try {
    const tracks = await api('GET', '/library/tracks?limit=5000');
    libraryTracks.set(tracks ?? []);
  } catch (e) {
    console.error('[library] tracks error:', e.message);
  }
}
