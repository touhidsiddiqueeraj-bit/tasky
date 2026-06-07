var CACHE = 'tasky-v3';

var STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './tasky.js',
  './tasky.css',
  './tasky-voice.css',
  './tasky-voice.js',
  './tasky-video.css',
  './tasky-video.js',
  './tasky-calendar.css',
  './tasky-calendar.js',
  './tasky-features.js',
  './tasky-collab.js',
  './tasky-deps-search.js',
  './tasky-subtask.js',
  './tasky-timer.js',
  './tasky-timer.css',
  './tasky-bulk.js',
  './tasky-activity.js',
  './tasky-whiteboard.js',
  './tasky-whiteboard.css',
  './tasky-palette.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Only handle same-origin GET requests
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // Don't cache data: URIs or chrome-extension: etc
  if (url.protocol === 'data:' || url.protocol === 'chrome-extension:') return;

  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(resp) {
        // Cache successful same-origin responses
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var clone = resp.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return resp;
      });
    }).catch(function() {
      // Offline fallback for known pages
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return caches.match('./index.html');
      }
    })
  );
});
