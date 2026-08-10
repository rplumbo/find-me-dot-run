const CACHE_PREFIX = 's100-spectator-';
const CACHE_NAME = 's100-spectator-v39';

const CORE_ASSETS = [
  './',
  './index.html',
  './track.html',
  './predict.html',
  './lookup.html',
  './explore.html',
  './compare.html',
  './about.html',
  './map.html',
  './css/style.css',
  './css/home.css',
  './css/map.css',
  './assets/superior-trail-hero-north.jpg',
  './js/track.js',
  './js/app.js',
  './js/lookup.js',
  './js/explore.js',
  './js/compare.js',
  './js/map.js',
  './js/sw-register.js',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/maplibre-gl.LICENSE.txt',
  './data/superior100-route.geojson',
  './data/superior100-aid-stations.json',
  './model.json',
  './named_runners.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(async keys => {
      const oldAppCaches = keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
      await Promise.all(oldAppCaches.map(key => caches.delete(key)));
      await self.clients.claim();

      // Existing pages already loaded their assets through the old worker.
      // Reload them once so the newly activated worker can serve current code.
      if (oldAppCaches.length) {
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(windows.map(client => client.navigate(client.url).catch(() => null)));
      }
    })
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  } catch {
    return await caches.match(request)
      || await caches.match(request, { ignoreSearch: true })
      || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const requiresFreshCode = request.mode === 'navigate'
    || ['document', 'script', 'style', 'worker'].includes(request.destination);
  if (requiresFreshCode) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);

      return cached || network;
    })
  );
});
