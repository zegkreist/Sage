const BASE = '/api';

/**
 * Generic fetch wrapper.
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path  — e.g. '/library/stats'
 * @param {*} [body]     — JSON-serializable body for POST/PUT/PATCH
 * @returns {Promise<*>} Parsed JSON response, or null for 204.
 * @throws {Error} With server's error message or "HTTP <status>"
 */
export async function api(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);

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
