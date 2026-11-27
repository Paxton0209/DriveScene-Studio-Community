// Cache-First Service Worker for content-hashed / immutable DriveScene assets.
// Eliminates repeated 304 revalidations caused by origin max-age=0 headers.
const CACHE_NAME = 'drivescene-immutable-v1';
const HTML_CACHE = 'drivescene-html-v1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isImmutableAsset(url) {
  const {pathname, searchParams} = url;
  if (searchParams.has('qa') || searchParams.has('retry')) return false;
  if (pathname.endsWith('/release.json')) return false;
  if (searchParams.has('v') || searchParams.has('engine-v')) {
    return /\.(?:js|css|gz|json|woff2|svg|png|jpg|jpeg|webp|wav)$/.test(pathname) ||
      pathname.endsWith('/pro-engine.html') ||
      pathname.endsWith('/engine.html');
  }
  return /\.(?:glb\.gz|bin\.gz|woff2|wav)$/.test(pathname);
}

function isProductionHtml(request, url) {
  if (LOCAL_HOSTS.has(url.hostname)) return false;
  if (url.searchParams.has('qa')) return false;
  return request.mode === 'navigate' || request.destination === 'document';
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  const keep = new Set([CACHE_NAME, HTML_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isImmutableAsset(url)) {
    // Key pro-engine.html by engine-v + path so different scene queries reuse the
    // exact same cached minimal HTML document without a network round-trip.
    const cacheKey = (url.pathname.endsWith('/pro-engine.html') || url.pathname.endsWith('/engine.html'))
      ? new Request(url.origin + url.pathname + '?engine-v=' + encodeURIComponent(url.searchParams.get('engine-v') || ''))
      : request;
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        const response = await fetch(request);
        if (response && response.ok && response.status === 200) {
          void cache.put(cacheKey, response.clone()).catch(() => {});
        }
        return response;
      })
    );
    return;
  }

  if (isProductionHtml(request, url)) {
    const htmlKey = new Request(url.origin + url.pathname);
    event.respondWith(
      caches.open(HTML_CACHE).then(async cache => {
        const hit = await cache.match(htmlKey);
        const network = fetch(request).then(response => {
          if (response && response.ok && response.status === 200) {
            void cache.put(htmlKey, response.clone()).catch(() => {});
          }
          return response;
        }).catch(() => null);
        if (hit) {
          event.waitUntil(network);
          return hit;
        }
        const fresh = await network;
        return fresh || fetch(request);
      })
    );
  }
});
