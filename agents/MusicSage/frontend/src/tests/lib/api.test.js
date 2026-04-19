import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '$lib/api.js';

describe('api()', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls fetch with correct URL prefix', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    const result = await api('GET', '/library/stats');
    expect(fetch).toHaveBeenCalledWith('/api/library/stats', expect.any(Object));
    expect(result).toEqual({ ok: true });
  });

  it('passes GET without body', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await api('GET', '/test');
    const [, opts] = fetch.mock.calls[0];
    expect(opts.method).toBe('GET');
    expect(opts.body).toBeUndefined();
  });

  it('serializes POST body as JSON', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await api('POST', '/playlists', { name: 'Test' });
    const [, opts] = fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"name":"Test"}');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('throws with server error message on non-ok', async () => {
    global.fetch.mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });
    await expect(api('GET', '/fail')).rejects.toThrow('Internal server error');
  });

  it('throws with HTTP status when body has no error field', async () => {
    global.fetch.mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({}),
    });
    await expect(api('GET', '/missing')).rejects.toThrow('HTTP 404');
  });

  it('returns null for 204 No Content', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 204 });
    const result = await api('DELETE', '/item/1');
    expect(result).toBeNull();
  });

  it('does not send Content-Type when body is null', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await api('GET', '/test');
    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBeUndefined();
  });
});
