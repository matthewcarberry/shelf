import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanLibrary } from "./library.js";
import { createLibraryWatcher, foldersToScan, normalizeScanSettings } from "./library-watcher.js";

async function tempLibrary(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const libraryDir = path.join(root, "library");
  const dataDir = path.join(root, "data");
  await fs.mkdir(libraryDir, { recursive: true });
  return {
    root,
    paths: {
      libraryDir,
      dataDir,
      convertedDir: path.join(dataDir, "converted"),
      coverDir: path.join(dataDir, "covers")
    }
  };
}

test("maps changed paths to the smallest set of existing folders", async () => {
  const { root, paths } = await tempLibrary("shelf-folders-");
  try {
    await fs.mkdir(path.join(paths.libraryDir, "Author/Book One"), { recursive: true });
    await fs.mkdir(path.join(paths.libraryDir, "Author/Book Two"), { recursive: true });
    await fs.writeFile(path.join(paths.libraryDir, "Author/Book One/book.epub"), "x");

    assert.deepEqual(foldersToScan(paths.libraryDir, ["Author/Book One/book.epub"]), ["Author/Book One"]);
    assert.deepEqual(foldersToScan(paths.libraryDir, ["Author/Book Two"]), ["Author/Book Two"]);
    assert.deepEqual(
      foldersToScan(paths.libraryDir, ["Author/Book One/book.epub", "Author", "Author/Book Two"]),
      ["Author"]
    );
    // Deleted paths fall back to their nearest existing parent.
    assert.deepEqual(foldersToScan(paths.libraryDir, ["Author/Gone/part.mp3"]), ["Author"]);
    // A change in the library root means a full scan.
    assert.equal(foldersToScan(paths.libraryDir, ["loose.epub"]), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial scan only touches files inside the given folders", async () => {
  const { root, paths } = await tempLibrary("shelf-partial-");
  try {
    await fs.mkdir(path.join(paths.libraryDir, "A/One"), { recursive: true });
    await fs.mkdir(path.join(paths.libraryDir, "B/Two"), { recursive: true });
    await fs.writeFile(path.join(paths.libraryDir, "A/One/one.txt"), "one");
    await fs.writeFile(path.join(paths.libraryDir, "B/Two/two.txt"), "two");
    const saved = [];
    const store = {
      listBooks: () => saved,
      getBook: () => null,
      upsertBook: async (book) => saved.push(book)
    };

    await scanLibrary(store, paths, { onlyDirs: ["B/Two"] });
    assert.deepEqual(saved.map((book) => book.relPath), ["B/Two/two.txt"]);

    // Folders outside the library are ignored.
    await scanLibrary(store, paths, { onlyDirs: ["../.."] });
    assert.equal(saved.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial scan keeps an audiobook's tracks from other folders", async () => {
  const { root, paths } = await tempLibrary("shelf-partial-audio-");
  try {
    const cd1 = path.join(paths.libraryDir, "Book/CD1");
    const cd2 = path.join(paths.libraryDir, "Book/CD2");
    await fs.mkdir(cd1, { recursive: true });
    await fs.mkdir(cd2, { recursive: true });
    await fs.writeFile(path.join(cd1, "01.mp3"), "a");
    await fs.writeFile(path.join(cd2, "01.mp3"), "b");
    const existing = {
      id: "existing-audiobook",
      title: "Book",
      author: "Someone",
      readingFormat: "audio",
      mediaType: "audiobook",
      audioFiles: [
        { path: path.join(cd1, "01.mp3"), relPath: "Book/CD1/01.mp3", filename: "01.mp3", title: "Part 1" },
        { path: path.join(cd2, "01.mp3"), relPath: "Book/CD2/01.mp3", filename: "01.mp3", title: "Part 2" }
      ]
    };
    const saved = [];
    const store = {
      listBooks: () => [existing],
      getBook: (id) => id === existing.id ? existing : null,
      upsertBook: async (book) => saved.push(book)
    };

    await scanLibrary(store, paths, { onlyDirs: ["Book/CD2"] });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, existing.id);
    assert.deepEqual(saved[0].audioFiles.map((track) => track.relPath).sort(), ["Book/CD1/01.mp3", "Book/CD2/01.mp3"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the watcher reports the folder a new book lands in", async () => {
  const { root, paths } = await tempLibrary("shelf-watch-");
  const watcher = createLibraryWatcher({
    libraryDir: paths.libraryDir,
    quietMs: 200,
    onChange: (folders) => reported.push(folders)
  });
  const reported = [];
  try {
    await fs.mkdir(path.join(paths.libraryDir, "Author"), { recursive: true });
    assert.equal(watcher.start(), true);
    await fs.mkdir(path.join(paths.libraryDir, "Author/New Book"));
    await fs.writeFile(path.join(paths.libraryDir, "Author/New Book/book.epub"), "x");
    for (let i = 0; i < 40 && reported.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(reported, [["Author/New Book"]]);
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scan settings fall back to defaults for bad values", () => {
  assert.deepEqual(normalizeScanSettings({ autoScan: "yes", periodicScan: true, scanIntervalMinutes: 7 }), {
    autoScan: true,
    partialScan: true,
    periodicScan: true,
    scanIntervalMinutes: 60
  });
});
