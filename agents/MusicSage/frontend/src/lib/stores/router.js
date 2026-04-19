import { writable } from 'svelte/store';

export const currentPage = writable('dashboard');

/**
 * Carries intent context when navigating to the Downloads page.
 * Shape: { tab: 'stormbringer' | 'tidecaller', artist: string } | null
 */
export const downloadIntent = writable(null);

/** Navigate to a page and sync window hash. */
export function navigate(page) {
  currentPage.set(page);
  if (typeof window !== 'undefined') {
    window.location.hash = page;
  }
}

/**
 * Navigate to the Downloads page with a pre-filled artist search.
 * @param {'stormbringer'|'tidecaller'} tab
 * @param {string} artist
 */
export function navigateToDownload(tab, artist) {
  downloadIntent.set({ tab, artist });
  navigate('downloads');
}

// Bootstrap from hash on initial load
if (typeof window !== 'undefined') {
  const initial = window.location.hash.slice(1);
  if (initial) currentPage.set(initial);

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.slice(1);
    if (h) currentPage.set(h);
  });
}
