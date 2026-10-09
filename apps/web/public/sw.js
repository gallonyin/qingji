const CACHE_PREFIX = "mynote-shell-";
const CACHE = `${CACHE_PREFIX}v2`;
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const navigation = event.request.mode === "navigate";
  if (!navigation && !SHELL.includes(url.pathname) && !url.pathname.startsWith("/assets/")) return;

  // Hashed assets stay useful offline and across releases; HTML checks for updates.
  const response = caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached && url.pathname.startsWith("/assets/")) return cached;
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) {
        event.waitUntil(cache.put(event.request, fresh.clone()).catch(() => {}));
        return fresh;
      }
      if (cached) return cached;
      if (navigation) return (await cache.match("/index.html")) || fresh;
      return fresh;
    } catch {
      if (cached) return cached;
      if (navigation) {
        const shell = await cache.match("/index.html");
        if (shell) return shell;
      }
      // Missing JS/images must never receive HTML with an incorrect MIME type.
      return Response.error();
    }
  });
  event.respondWith(response);
});
