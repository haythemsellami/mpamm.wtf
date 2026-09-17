interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
interface Context { waitUntil(work: Promise<unknown>): void }
declare const caches: { default: EdgeCache };

/** Only immutable public aggregates may enter the edge cache. Current-window
 * manifests, errors, authenticated requests and the live stream pass through. */
export async function serveAnalytics(request: Request, cache: EdgeCache, context: Context,
  origin: (request: Request) => Promise<Response> = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.search || request.headers.has('Authorization')
    || request.headers.has('Cookie') || !/^\/api\/analytics\/[a-f0-9]{64}\.json$/.test(url.pathname)) return origin(request);
  // Cache API keys must distinguish representations even on edges that do
  // not vary stored objects by the Accept-Encoding request header.
  const gzip = (request.headers.get('Accept-Encoding') ?? '').split(',').some((part) => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';');
    return coding === 'gzip' && !parameters.some((p) => p.trim().startsWith('q=') && Number(p.trim().slice(2)) === 0);
  });
  const headers = new Headers(request.headers);
  headers.set('Accept-Encoding', gzip ? 'gzip' : 'identity');
  const keyUrl = new URL(url);
  keyUrl.searchParams.set('representation', gzip ? 'gzip' : 'identity');
  const key = new Request(keyUrl, { headers });
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await origin(new Request(request, { headers }));
  if (response.status === 200 && !response.headers.has('Set-Cookie')
    && /\bpublic\b/.test(response.headers.get('Cache-Control') ?? '')
    && /\bimmutable\b/.test(response.headers.get('Cache-Control') ?? '')) {
    context.waitUntil(cache.put(key, response.clone()));
  }
  return response;
}

export default {
  fetch(request: Request, _env: unknown, context: Context): Promise<Response> {
    return serveAnalytics(request, caches.default, context);
  },
};
