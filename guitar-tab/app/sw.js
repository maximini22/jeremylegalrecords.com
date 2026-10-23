/* Quiet offline cache for the app at /app/ (scope ./). Bump VERSION when shell files change. */
var VERSION = 'jlr-guitar-tab-v5';
var SHELL = [
  './',
  './index.html',
  './app.css',
  './js/audio.js',
  './js/model.js',
  './js/midi.js',
  './js/app.js',
  './manifest.webmanifest',
  '../css/jlr-theme.css',
  '../assets/jlr-logo.png',
  '../icons/icon-192.png',
  '../icons/icon-512.png',
  '../icons/maskable-192.png',
  '../icons/maskable-512.png',
  '../icons/favicon-32.png',
  '../icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('jlr-guitar-tab-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Network first for page loads (so updates show up), cache first for static files.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put('./index.html', copy); });
      return res;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
