import type { Book, ProgressState, ReaderInfo } from "./types";

const AUDIO_CACHE = "shelfstream-offline-audio-v1";
const APP_CACHE = "shelfstream-offline-app-v1";
const MANIFEST_KEY = "shelfstream-offline-audiobooks-v1";
const PROGRESS_KEY = "shelfstream-offline-progress-v1";

interface OfflineAudiobookManifest {
  bookId: string;
  title: string;
  trackUrls: string[];
  cachedAt: string;
  size: number;
}

type OfflineManifests = Record<string, OfflineAudiobookManifest>;
type OfflineProgress = Record<string, ProgressState>;

let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

export function offlineStorageSupported() {
  return "serviceWorker" in navigator && "caches" in window;
}

export function registerOfflineSupport() {
  if (!offlineStorageSupported()) {
    return Promise.reject(new Error("Offline storage is not supported by this browser"));
  }
  registrationPromise ||= navigator.serviceWorker.register("/sw.js");
  return registrationPromise;
}

export async function isAudiobookStoredOffline(bookId: string) {
  if (!offlineStorageSupported()) {
    return false;
  }
  const manifest = readManifests()[bookId];
  if (!manifest || manifest.trackUrls.length === 0) {
    return false;
  }
  const cache = await caches.open(AUDIO_CACHE);
  const matches = await Promise.all(manifest.trackUrls.map((url) => cache.match(url)));
  return matches.every(Boolean);
}

export async function storeAudiobookOffline({
  book,
  tracks,
  onProgress
}: {
  book: Book;
  tracks: ReaderInfo["audioTracks"];
  onProgress?: (completed: number, total: number, label: string) => void;
}) {
  if (!offlineStorageSupported()) {
    throw new Error("Offline storage is not supported by this browser");
  }
  if (tracks.length === 0) {
    throw new Error("This audiobook has no tracks to store");
  }

  await ensureStorageCapacity(book.size);
  await registerOfflineSupport();
  await navigator.serviceWorker.ready;

  const appCache = await caches.open(APP_CACHE);
  await cacheAppResources(appCache, book);

  const audioCache = await caches.open(AUDIO_CACHE);
  const storedUrls: string[] = [];
  let downloadedBytes = 0;

  try {
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      onProgress?.(index, tracks.length, track.title || `Part ${index + 1}`);
      const request = new Request(track.fileUrl, { credentials: "same-origin" });
      const response = await fetch(request);
      if (!response.ok) {
        throw new Error(`Unable to download ${track.title || `part ${index + 1}`}`);
      }
      downloadedBytes += Number(response.headers.get("content-length") || 0);
      await audioCache.put(request, response);
      storedUrls.push(track.fileUrl);
      onProgress?.(index + 1, tracks.length, track.title || `Part ${index + 1}`);
    }
  } catch (error) {
    await Promise.all(storedUrls.map((url) => audioCache.delete(url)));
    if (Object.keys(readManifests()).length === 0) {
      await caches.delete(APP_CACHE);
    }
    throw error;
  }

  const manifests = readManifests();
  manifests[book.id] = {
    bookId: book.id,
    title: book.title,
    trackUrls: tracks.map((track) => track.fileUrl),
    cachedAt: new Date().toISOString(),
    size: downloadedBytes || book.size
  };
  writeJson(MANIFEST_KEY, manifests);
  return manifests[book.id];
}

export async function removeOfflineAudiobook(bookId: string) {
  if (!offlineStorageSupported()) {
    return;
  }
  const manifests = readManifests();
  const manifest = manifests[bookId];
  if (manifest) {
    const cache = await caches.open(AUDIO_CACHE);
    await Promise.all(manifest.trackUrls.map((url) => cache.delete(url)));
    delete manifests[bookId];
    writeJson(MANIFEST_KEY, manifests);
  }

  if (Object.keys(manifests).length === 0) {
    await caches.delete(APP_CACHE);
  }
}

export async function clearOfflineLibrary() {
  if ("caches" in window) {
    await Promise.all([caches.delete(AUDIO_CACHE), caches.delete(APP_CACHE)]);
  }
  window.localStorage.removeItem(MANIFEST_KEY);
  window.localStorage.removeItem(PROGRESS_KEY);
}

export function getOfflineProgress(bookId: string) {
  return readJson<OfflineProgress>(PROGRESS_KEY, {})[bookId] || null;
}

export function rememberOfflineProgress(bookId: string, progress: ProgressState) {
  const allProgress = readJson<OfflineProgress>(PROGRESS_KEY, {});
  allProgress[bookId] = {
    ...progress,
    updatedAt: new Date().toISOString()
  };
  writeJson(PROGRESS_KEY, allProgress);
  return allProgress[bookId];
}

export function forgetOfflineProgress(bookId: string) {
  const allProgress = readJson<OfflineProgress>(PROGRESS_KEY, {});
  delete allProgress[bookId];
  writeJson(PROGRESS_KEY, allProgress);
}

async function cacheAppResources(cache: Cache, book: Book) {
  const resourceUrls = new Set<string>(["/", "/api/auth/status", "/api/books", "/api/preferences", `/api/books/${book.id}/reader`]);
  for (const element of document.querySelectorAll("script[src],link[href]")) {
    const value = element.getAttribute("src") || element.getAttribute("href");
    if (!value) {
      continue;
    }
    const url = new URL(value, window.location.href);
    if (url.origin === window.location.origin) {
      resourceUrls.add(`${url.pathname}${url.search}`);
    }
  }
  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith("/assets/")) {
      resourceUrls.add(`${url.pathname}${url.search}`);
    }
  }
  if (book.coverUrl) {
    resourceUrls.add(book.coverUrl);
  }

  for (const url of resourceUrls) {
    const request = new Request(url, { credentials: "same-origin" });
    const response = await fetch(request);
    if (!response.ok) {
      throw new Error(`Unable to prepare ${book.title} for offline use`);
    }
    await cache.put(request, response);
  }
}

async function ensureStorageCapacity(requiredBytes: number) {
  if (!navigator.storage?.estimate || !requiredBytes) {
    return;
  }
  const estimate = await navigator.storage.estimate();
  if (!estimate.quota || estimate.usage === undefined) {
    return;
  }
  const available = estimate.quota - estimate.usage;
  if (available < requiredBytes) {
    throw new Error("This device does not have enough browser storage for the complete audiobook");
  }
}

function readManifests() {
  return readJson<OfflineManifests>(MANIFEST_KEY, {});
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
}
