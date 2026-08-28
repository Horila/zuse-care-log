/* Zuse Care Log — offline shell.
 *
 * Stale-while-revalidate: the cached copy renders instantly, a fresh copy is
 * fetched in the background, so an update lands on the *next* open rather than
 * this one. That is the right trade for an app opened many times a day.
 * Bump CACHE to evict old caches on activate.
 */
const CACHE = 'zuse-v2';
const APP = './zuse-care-log.html';
const SHELL = [APP, './index.html', './manifest.json'];

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
