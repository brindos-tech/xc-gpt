// Service worker: makes the site installable and keeps the last-loaded
// data available offline (on a ramp with no signal, say).
//
// - Page and data: network first, so a connected visit always sees the
//   current deploy; the cached copy is only the fallback.
// - Versioned assets (?v=<sha>, see scripts/stamp-version.js) and the
//   pinned Leaflet CDN files: cache first — a given URL never changes.
// - Map tiles are never cached: OpenStreetMap's tile policy discourages
//   bulk caching, and offline the app is still usable without the basemap.
//
// Lives at the site root (not under assets/) because a worker can only
// control pages at or below its own path.

const CACHE = "xc-gpt-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTile(url) {
  return /tile\.openstreetmap\.org$/.test(url.hostname);
}

function isPinnedCdn(url) {
  return url.hostname === "cdnjs.cloudflare.com";
}

// One cached copy per path: storing a new ?v= drops the previous deploy's
// copy instead of letting every deploy's assets pile up.
async function putLatest(cache, request, response) {
  const url = new URL(request.url);
  const stale = await cache.keys(request, { ignoreSearch: true });
  await Promise.all(stale.filter((r) => r.url !== url.href).map((r) => cache.delete(r)));
  await cache.put(request, response);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await putLatest(cache, request, response.clone());
    return response;
  } catch (err) {
    // A data URL carries the deploy version, so offline the exact URL may
    // not be cached yet; any cached version beats nothing.
    const cached = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await putLatest(cache, request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isTile(url)) return;

  if (isPinnedCdn(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" || url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request));
    return;
  }
  // Unversioned asset URLs only happen in local dev; keep those fresh.
  event.respondWith(url.searchParams.has("v") ? cacheFirst(request) : networkFirst(request));
});
