const AUDIO_CACHE = "shelfstream-offline-audio-v1";
const APP_CACHE = "shelfstream-offline-app-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith("shelfstream-offline-app-") && name !== APP_CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (/^\/api\/books\/[^/]+\/audio\/\d+$/.test(url.pathname)) {
    event.respondWith(audioResponse(request));
    return;
  }

  if (request.mode === "navigate" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) {
    event.respondWith(networkFirst(request));
  }
});

async function audioResponse(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (!cached) {
    return fetch(request);
  }

  const range = request.headers.get("range");
  if (!range) {
    return cached;
  }

  const blob = await cached.blob();
  const bounds = parseRange(range, blob.size);
  if (!bounds) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` }
    });
  }

  const sliced = blob.slice(bounds.start, bounds.end + 1, cached.headers.get("content-type") || blob.type);
  const headers = new Headers(cached.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(sliced.size));
  headers.set("Content-Range", `bytes ${bounds.start}-${bounds.end}/${blob.size}`);
  return new Response(sliced, { status: 206, headers });
}

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && await cache.match(request)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      const shell = await cache.match("/");
      if (shell) {
        return shell;
      }
    }
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "This item is not available offline" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }
    return Response.error();
  }
}

function parseRange(value, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
  if (!match) {
    return null;
  }
  if (!match[1] && match[2]) {
    const length = Number.parseInt(match[2], 10);
    if (!Number.isFinite(length) || length <= 0) {
      return null;
    }
    return { start: Math.max(0, total - length), end: total - 1 };
  }
  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
  return start >= 0 && start <= end && start < total ? { start, end } : null;
}
