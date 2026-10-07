// CacheStorage is shared by every project on this origin. Only retire caches
// belonging to this installation, so another keyboard or old demo stays offline.
const CACHE_PREFIX = `tonnetz-${encodeURIComponent(new URL("./", self.location.href).pathname)}-`;
const CACHE_NAME = `${CACHE_PREFIX}v39-scoped-cache`;
const ASSETS = [
  "./",
  "./index.html",
  "./i18n.js?v=1",
  "./app.css?v=20",
  "./app.js?v=21",
  "./workbench.css?v=11",
  "./workbench.js?v=12",
  "./workbench-data.js",
  "./accompaniment.js",
  "./improvisation.js",
  "./MELODY-DATA-NOTICE.txt",
  "./arrangement-random.js",
  "./walking-bass.js",
  "./performance-controls.js",
  "./chord-lookahead.js",
  "./chord-timeline.js",
  "./learn.css?v=1",
  "./learn.js",
  "./lib/harmony-models.js",
  "./lib/harmony-transformer.js",
  "./lib/melody-model.js",
  "./lib/melody-transformer-weights.js",
  "./lib/chord-vocabulary.js",
  "./lib/tonality.js",
  "./vendor/katex/katex.min.css",
  "./vendor/katex/katex.min.js",
  "./media/piano/manifest.json",
  "./media/piano/NOTICE.txt",
  "./media/piano/SOURCE-README.txt",
  "./media/piano/A2.mp3",
  "./media/piano/A3.mp3",
  "./media/piano/A4.mp3",
  "./media/piano/A5.mp3",
  "./media/piano/C2.mp3",
  "./media/piano/C3.mp3",
  "./media/piano/C4.mp3",
  "./media/piano/C5.mp3",
  "./media/piano/C6.mp3",
  "./media/piano/Ds2.mp3",
  "./media/piano/Ds3.mp3",
  "./media/piano/Ds4.mp3",
  "./media/piano/Ds5.mp3",
  "./media/piano/Fs2.mp3",
  "./media/piano/Fs3.mp3",
  "./media/piano/Fs4.mp3",
  "./media/piano/Fs5.mp3",
  "./media/bass/As1.mp3",
  "./media/bass/As2.mp3",
  "./media/bass/Cs2.mp3",
  "./media/bass/Cs3.mp3",
  "./media/bass/E1.mp3",
  "./media/bass/E2.mp3",
  "./media/bass/E3.mp3",
  "./media/bass/G1.mp3",
  "./media/bass/G2.mp3",
  "./media/bass/NOTICE.txt",
  "./media/bass/manifest.json",
  "./media/guitar/A3.mp3",
  "./media/guitar/A4.mp3",
  "./media/guitar/C4.mp3",
  "./media/guitar/C5.mp3",
  "./media/guitar/Ds4.mp3",
  "./media/guitar/Ds5.mp3",
  "./media/guitar/Fs3.mp3",
  "./media/guitar/Fs4.mp3",
  "./media/guitar/Fs5.mp3",
  "./media/guitar/NOTICE.txt",
  "./media/guitar/manifest.json",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestURL = new URL(event.request.url);
  const scopeURL = new URL(self.registration.scope);
  if (requestURL.origin !== scopeURL.origin || !requestURL.pathname.startsWith(scopeURL.pathname)) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
      }
      return response;
    }).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") return cache.match(new URL("./index.html", self.location.href).href);
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })
  );
});
