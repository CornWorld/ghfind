/**
 * Cheap, colo-local caches for read models that are not worth a Workers KV
 * write: the Workers Cache API (`caches.default`, free writes, per data
 * center) plus a bounded in-isolate map in front of it.
 *
 * Use these for results that a crawler long tail rarely re-reads (empty
 * discovery answers, crawler renders): a KV write costs more than the
 * database read it would save. Everything here is best-effort — outside
 * Workers (Node tests, scripts) the Cache API is absent and only the
 * in-isolate tier works.
 */

// Cache API keys must be URLs; this host is never fetched or served.
const CACHE_KEY_ORIGIN = "https://edge-cache.ghfind.internal/";

type DefaultCache = {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
};

function defaultCache(): DefaultCache | null {
  try {
    const storage = (globalThis as { caches?: { default?: DefaultCache } }).caches;
    return storage?.default ?? null;
  } catch {
    return null;
  }
}

const cacheUrl = (key: string) => `${CACHE_KEY_ORIGIN}${encodeURIComponent(key)}`;

export async function edgeCacheGet<T>(key: string): Promise<T | null> {
  const cache = defaultCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheUrl(key));
    return hit ? ((await hit.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function edgeCachePut(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;
  try {
    await cache.put(
      cacheUrl(key),
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
        },
      }),
    );
  } catch {
    // best-effort
  }
}

/** Bounded TTL map (oldest-inserted evicted first) for one isolate. */
export function createLocalCache<T>(ttlMs: number, maxEntries: number) {
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
