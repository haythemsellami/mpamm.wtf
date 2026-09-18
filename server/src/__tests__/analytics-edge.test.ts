import { describe, expect, it, vi } from 'vitest';
import { serveAnalytics } from '../../../infra/analytics-cache-worker.js';

describe('immutable analytics edge cache', () => {
  it('serves repeated readers without origin egress and keeps corrected revisions separate', async () => {
    const saved = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    const cache = { match: async (request: Request) => saved.get(request.url)?.clone(), put: async (request: Request, response: Response) => { saved.set(request.url, response); } };
    const context = { waitUntil: (work: Promise<unknown>) => { pending.push(work); } };
    const origin = vi.fn(async () => new Response('{"value":1}', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }));
    const first = new Request(`https://mpamm.wtf/api/analytics/${'a'.repeat(64)}.json`);
    for (let i = 0; i < 100; i++) { expect(await (await serveAnalytics(first, cache, context, origin)).json()).toEqual({ value: 1 }); await Promise.all(pending); }
    expect(origin).toHaveBeenCalledTimes(1);
    const corrected = new Request(first.url.replace('a'.repeat(64), 'b'.repeat(64)));
    await serveAnalytics(corrected, cache, context, origin);
    expect(origin).toHaveBeenCalledTimes(2);
    expect(saved.size).toBe(2);
  });

  it('never caches errors, manifests, private responses or personalized requests', async () => {
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
    const context = { waitUntil: (work: Promise<unknown>) => { void work; } };
    const url = `https://mpamm.wtf/api/analytics/${'a'.repeat(64)}.json`;
    for (const status of [404, 503]) await serveAnalytics(new Request(url), cache, context, async () => new Response('error', { status }));
    await serveAnalytics(new Request(url), cache, context, async () => new Response('private', { headers: { 'Cache-Control': 'private, immutable' } }));
    const origin = vi.fn(async () => new Response('ok', { headers: { 'Cache-Control': 'public, immutable' } }));
    await serveAnalytics(new Request('https://mpamm.wtf/api/leaderboard/publication?days=1'), cache, context, origin);
    await serveAnalytics(new Request(url, { headers: { Cookie: 'session=private' } }), cache, context, origin);
    expect(origin).toHaveBeenCalledTimes(2);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
