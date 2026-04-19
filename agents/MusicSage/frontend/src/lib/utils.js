/** HTML-escape a string to prevent XSS when injecting into the DOM. */
export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a JS timestamp (ms) or Date to a locale date string. */
export function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Format bytes to human-readable string. */
export function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Format bytes/s as a human-readable speed. */
export function fmtSpeed(bps) {
  return `${fmtBytes(bps)}/s`;
}

/**
 * Format milliseconds into m:ss or h:mm:ss.
 * @param {number|null} ms
 */
export function fmtDuration(ms) {
  if (!ms) return '—';
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a Unix timestamp (seconds) as relative time in pt-BR.
 * @param {number|null} ts  Unix seconds
 */
export function relTime(ts) {
  if (!ts) return '—';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return 'agora';
  if (diff < 3600)  return `há ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`;
  const days = Math.floor(diff / 86400);
  if (days === 1)   return 'ontem';
  if (days < 30)    return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'há 1 mês';
  return `há ${months} meses`;
}

/**
 * Derive a human-readable mood label from audio analysis averages.
 * @param {number|null} energy        0–10
 * @param {number|null} valence       0–10
 * @param {number|null} danceability  0–10
 * @param {string|null} topMood       fallback from server
 */
export function deriveMoodLabel(energy, valence, danceability, topMood) {
  if (energy == null && valence == null) return topMood ?? 'Indefinido';
  const e = energy ?? 5;
  const v = valence ?? 5;
  const d = danceability ?? 5;
  if (e >= 7 && v >= 6 && d >= 6) return 'Animado 🎉';
  if (e >= 7 && v >= 6)           return 'Energético 🔥';
  if (e >= 7 && v < 4)            return 'Intenso ⚡';
  if (e >= 6 && v >= 6 && d >= 6) return 'Dançante 💃';
  if (e < 4  && v >= 6)           return 'Contemplativo 🌤';
  if (e < 4  && v < 4)            return 'Melancólico 💙';
  if (e < 4)                      return 'Relaxado 🌊';
  if (v >= 7)                     return 'Positivo ☀️';
  if (v < 3)                      return 'Sombrio 🌑';
  return topMood ?? 'Equilibrado 🎵';
}

/** Clamp n between lo and hi. */
export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Debounce a function. */
export function debounce(fn, ms = 300) {
  let tid;
  return (...args) => {
    clearTimeout(tid);
    tid = setTimeout(() => fn(...args), ms);
  };
}
