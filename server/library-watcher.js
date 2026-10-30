import fsSync from "node:fs";
import path from "node:path";

export const SCAN_INTERVAL_MINUTES = [15, 30, 60, 120, 360, 720, 1440];

export const DEFAULT_SCAN_SETTINGS = Object.freeze({
  autoScan: true,
  partialScan: true,
  periodicScan: false,
  scanIntervalMinutes: 60
});

const SETTINGS_KEY = "library_scan_settings";

export function readScanSettings(store) {
  const row = store.sqlite.prepare("SELECT value FROM metadata WHERE key = ?").get(SETTINGS_KEY);
  if (!row) return { ...DEFAULT_SCAN_SETTINGS };
  try {
    return normalizeScanSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SCAN_SETTINGS };
  }
}

export async function writeScanSettings(store, patch) {
  const next = normalizeScanSettings({ ...readScanSettings(store), ...patch });
  await store.queueSqliteWrite((sqlite) => {
    sqlite.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SETTINGS_KEY, JSON.stringify(next));
  });
  return next;
}

export function normalizeScanSettings(value = {}) {
  const pick = (key) => typeof value[key] === "boolean" ? value[key] : DEFAULT_SCAN_SETTINGS[key];
  const interval = Number(value.scanIntervalMinutes);
  return {
    autoScan: pick("autoScan"),
    partialScan: pick("partialScan"),
    periodicScan: pick("periodicScan"),
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES.includes(interval)
      ? interval
      : DEFAULT_SCAN_SETTINGS.scanIntervalMinutes
  };
}

// Watches the library folder, plus any library folders outside it
// (`extraRoots`), and reports which folders changed once things have been
// quiet for `quietMs`, so a download that writes many files over a few seconds
// becomes one scan. `onChange` receives folders (library-relative, or absolute
// for folders outside the library root), or null when the whole library should
// be scanned.
export function createLibraryWatcher({ libraryDir, extraRoots = [], onChange, quietMs = 10_000, log = console }) {
  let watchers = [];
  let roots = [];
  let timer = null;
  let changed = new Map();
  let fullScan = false;
  let lastError = null;

  const flush = () => {
    timer = null;
    const pending = changed;
    const scanEverything = fullScan;
    changed = new Map();
    fullScan = false;
    if (scanEverything) {
      onChange(null);
      return;
    }
    const folders = [];
    for (const [root, relPaths] of pending) {
      const found = foldersToScan(root, [...relPaths]);
      if (root === libraryDir) {
        if (!found) {
          onChange(null);
          return;
        }
        folders.push(...found);
      } else {
        folders.push(...(found || ["."]).map((folder) => path.join(root, folder)));
      }
    }
    onChange(folders);
  };

  const record = (root, filename) => {
    if (!filename) {
      if (root === libraryDir) fullScan = true;
      else record(root, ".");
      return;
    }
    if (!changed.has(root)) changed.set(root, new Set());
    changed.get(root).add(String(filename));
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, quietMs);
  };

  const watchRoot = (root) => {
    const watcher = fsSync.watch(root, { recursive: true }, (_event, filename) => record(root, filename));
    watcher.on("error", (error) => {
      lastError = error.message;
      log.error(`Library watcher stopped for ${root}`, error);
      watcher.close();
      watchers = watchers.filter((item) => item !== watcher);
    });
    watchers.push(watcher);
  };

  return {
    start() {
      if (watchers.length) return true;
      lastError = null;
      roots = [libraryDir, ...extraRoots.filter((root) => root !== libraryDir)];
      try {
        fsSync.mkdirSync(libraryDir, { recursive: true });
        watchRoot(libraryDir);
      } catch (error) {
        lastError = error.message;
        log.error("Unable to watch the library folder", error);
        this.stop();
        return false;
      }
      for (const root of roots.slice(1)) {
        try {
          watchRoot(root);
        } catch (error) {
          lastError = error.message;
          log.error(`Unable to watch library folder ${root}`, error);
        }
      }
      return true;
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      changed = new Map();
      fullScan = false;
      for (const watcher of watchers) watcher.close();
      watchers = [];
    },
    // Swaps the folders outside the library root, restarting if running.
    setExtraRoots(next) {
      const same = next.length === extraRoots.length && next.every((root, index) => root === extraRoots[index]);
      if (same) return;
      extraRoots = [...next];
      if (watchers.length) {
        this.stop();
        this.start();
      }
    },
    status() {
      return { watching: watchers.length > 0, error: lastError };
    }
  };
}

// Turns changed paths into the smallest set of existing folders that covers
// them. A changed file maps to its folder; a changed folder maps to itself; a
// path that no longer exists maps to its nearest existing parent. Returns null
// when the library root itself changed, meaning scan everything.
export function foldersToScan(libraryDir, relPaths) {
  const folders = new Set();
  for (const relPath of relPaths) {
    let folder = normalize(relPath);
    const absolute = path.join(libraryDir, folder);
    let isDirectory = false;
    try {
      isDirectory = fsSync.statSync(absolute).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) folder = path.posix.dirname(folder);
    while (folder !== "." && !fsSync.existsSync(path.join(libraryDir, folder))) {
      folder = path.posix.dirname(folder);
    }
    if (folder === "." || folder === "") return null;
    folders.add(folder);
  }

  const sorted = [...folders].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const folder of sorted) {
    const lower = folder.toLowerCase();
    if (!kept.some((parent) => lower === parent.toLowerCase() || lower.startsWith(`${parent.toLowerCase()}/`))) {
      kept.push(folder);
    }
  }
  return kept;
}

function normalize(value) {
  return value.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}
