const BASE = '/api';

/**
 * Generic fetch wrapper.
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path  — e.g. '/library/stats'
 * @param {*} [body]     — JSON-serializable body for POST/PUT/PATCH
 * @param {{timeoutMs?: number}} [opts] — aborta após timeoutMs (default 120s;
 *        0 desativa). Chamadas longas de LLM devem passar timeoutMs maior.
 * @returns {Promise<*>} Parsed JSON response, or null for 204.
 * @throws {Error} With server's error message, timeout message, or "HTTP <status>"
 */
export async function api(method, path, body = null, { timeoutMs = 120_000 } = {}) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (timeoutMs > 0) opts.signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Tempo esgotado (${Math.round(timeoutMs / 1000)}s) em ${path}`);
    }
    throw err;
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return null;

  return res.json();
}

/** Convenience helpers */
export const get  = (path)        => api('GET',    path);
export const post = (path, body)  => api('POST',   path, body);
export const put  = (path, body)  => api('PUT',    path, body);
export const del  = (path)        => api('DELETE', path);
export const patch = (path, body) => api('PATCH',  path, body);
