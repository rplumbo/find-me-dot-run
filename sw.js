const CACHE_NAME = 's100-spectator-v21';

const CORE_ASSETS = [
  './',
  './index.html',
  './track.html',
  './predict.html',
  './lookup.html',
  './explore.html',
  './compare.html',
  './about.html',
  './css/style.css',
  './js/track.js',
  './js/app.js',
  './js/lookup.js',
  './js/explore.js',
  './js/compare.js',
  './js/sw-register.js',
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
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

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
