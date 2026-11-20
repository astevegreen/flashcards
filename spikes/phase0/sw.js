const CACHE_NAME = 'flashcards-phase0-v1';
const ASSETS = [
  './',
  './index.html',
  './drawing.html',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './chime.wav',
  './kanjivg-098df.json',
  './kanjivg-08a9e.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      });
    }),
  );
});
