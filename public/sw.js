// Beam service worker — offline-first, hand-written, no workbox.
//
// Install precaches the app shell (all three pages). Every other GET is
// cache-first with a runtime cache fallback, so the first online visit
// warms everything and the app then runs forever in airplane mode.

// Bump this when the app shell changes. Hashed Vite assets are filled into
// this cache at runtime after the new shell is installed.
const CACHE = "beam-v6";
const SHELL = ["./", "./index.html", "./send/", "./receive/", "./beacon/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && (response.status === 200 || response.type === "opaque")) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, clone)));
        }
        return response;
      }).catch((err) => {
        if (event.request.mode === "navigate") return caches.match("./");
        throw err;
      });
    }),
  );
});
