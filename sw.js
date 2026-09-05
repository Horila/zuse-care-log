/* Zuse Care Log — offline shell.
 *
 * Stale-while-revalidate: the cached copy renders instantly, a fresh copy is
 * fetched in the background, so an update lands on the *next* open rather than
 * this one. That is the right trade for an app opened many times a day.
 * Bump CACHE to evict old caches on activate.
 */
const CACHE = 'zuse-v6';
const APP = './zuse-care-log.html';
const SHELL = [APP, './index.html', './manifest.json'];
const PERIODIC_SYNC_TAG = 'zuse-periodic-sync';
const RETRY_SYNC_TAG = 'zuse-sync-retry';

// Neither event can reach the Google Sheet itself — the sync secret and the
// merge logic live in the page, not here. Both just wake an open tab (if any)
// to run its own syncNow(). Chrome also decides the real fire time for
// periodicsync; the tag's minInterval is a hint, not a schedule.
async function wakeClientsToSync() {
  const clientsList = await self.clients.matchAll({ type: 'window' });
  clientsList.forEach(c => c.postMessage({ type: 'zuse-sync-now' }));
}

self.addEventListener('periodicsync', ev => {
  if (ev.tag === PERIODIC_SYNC_TAG) ev.waitUntil(wakeClientsToSync());
});

self.addEventListener('sync', ev => {
  if (ev.tag === RETRY_SYNC_TAG) ev.waitUntil(wakeClientsToSync());
});

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);

    const net = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(async () => {
      if (hit) return hit;
      // Offline, uncached, and it's a page load (e.g. the bare directory URL
      // rather than the file itself) — serve the app shell.
      if (req.mode === 'navigate') {
        const app = await cache.match(APP);
        if (app) return app;
      }
      return Response.error();
    });

    return hit || net;
  })());
});
