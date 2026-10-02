// ─── downloads.js — store global de downloads com polling ─────────────────
// Faz polling de GET /api/tools/queue, compara com o estado anterior e emite
// toasts quando um download termina (completed/done) ou falha (error/failed).
// O poller só roda enquanto a tab está ativa (document.hidden) e é instalado
// uma única vez em App.svelte via startDownloadsPoller().
import { get } from '$lib/api.js';
import { toast } from '$lib/stores/toast.js';

const POLL_INTERVAL_MS = 10_000;

// Map<id, status> do último snapshot visto
let _prev = new Map();
let _timer = null;
let _polling = false;

const DONE = new Set(['completed', 'done', 'complete', 'finished']);
const FAILED = new Set(['error', 'failed', 'cancelled']);

function isDone(status)   { return DONE.has(String(status ?? '').toLowerCase()); }
function isFailed(status) { return FAILED.has(String(status ?? '').toLowerCase()); }

async function pollOnce() {
  if (_polling) return;
  _polling = true;
  try {
    const snapshot = await get('/tools/queue');
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const current = new Map(items.map(it => [String(it.id), it]));

    for (const [id, item] of current) {
      const before = _prev.get(id);
      if (!before) continue; // item novo — nada a anunciar
      if (before.status === item.status) continue;
      const title = item.title ?? id;
      if (isDone(item.status)) {
        toast.success(`✓ Download concluído: ${title}`);
      } else if (isFailed(item.status)) {
        toast.error(`✕ Download falhou: ${title}${item.lastError ? ` — ${item.lastError}` : ''}`);
      }
    }

    _prev = current;
  } catch {
    // silencioso — indisponibilidade do backend não deve spammar toasts
  } finally {
    _polling = false;
  }
}

function tick() {
  if (!document.hidden) pollOnce();
}

/** Instala o poller global. Chamar uma única vez (App.svelte onMount). */
export function startDownloadsPoller() {
  if (_timer) return () => {};
  tick();
  _timer = setInterval(tick, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(_timer);
    _timer = null;
    document.removeEventListener('visibilitychange', tick);
  };
}
