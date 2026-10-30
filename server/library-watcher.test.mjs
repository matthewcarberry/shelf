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

test("scans cover library folders outside the library root", async () => {
  const { root, paths } = await tempLibrary("shelf-outside-");
  try {
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(path.join(elsewhere, "Author"), { recursive: true });
    await fs.mkdir(path.join(paths.libraryDir, "A"), { recursive: true });
    await fs.writeFile(path.join(elsewhere, "Author/far.txt"), "far");
    await fs.writeFile(path.join(paths.libraryDir, "A/near.txt"), "near");
    const saved = [];
    const store = {
      listBooks: () => saved,
      getBook: () => null,
      upsertBook: async (book) => saved.push(book)
    };

    await scanLibrary(store, paths, { extraRoots: [elsewhere] });
    // Books under the library root keep library-relative paths (and IDs);
    // books elsewhere are keyed by their full path.
    assert.deepEqual(saved.map((book) => book.relPath).sort(), [
      "A/near.txt",
      path.join(elsewhere, "Author/far.txt").split(path.sep).join("/")
    ].sort());

    saved.length = 0;
    await scanLibrary(store, paths, { extraRoots: [elsewhere], onlyDirs: [path.join(elsewhere, "Author")] });
    assert.equal(saved.length, 1);
    // Without the folder being a library folder, it's out of bounds.
    saved.length = 0;
    await scanLibrary(store, paths, { onlyDirs: [path.join(elsewhere, "Author")] });
    assert.equal(saved.length, 0);
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

test("moved audio files keep their audiobook and skip re-reading tags", async () => {
  const { root, paths } = await tempLibrary("shelf-moved-audio-");
  try {
    const newFolder = path.join(paths.libraryDir, "audiobooks/Author/Book");
    await fs.mkdir(newFolder, { recursive: true });
    const file = path.join(newFolder, "01.mp3");
    // Not a real mp3: re-reading its tags would lose the cached title.
    await fs.writeFile(file, "moved");
    const stat = await fs.stat(file);
    const existing = {
      id: "existing-audiobook",
      title: "Book",
      author: "Someone",
      readingFormat: "audio",
      mediaType: "audiobook",
      audioFiles: [{
        path: path.join(paths.libraryDir, "Author/Book/01.mp3"),
        relPath: "Author/Book/01.mp3",
        filename: "01.mp3",
        title: "Cached Part 1",
        size: stat.size,
        modifiedMs: stat.mtimeMs
      }]
    };
    const saved = [];
    const store = {
      listBooks: () => [existing],
      getBook: (id) => id === existing.id ? existing : null,
      upsertBook: async (book) => saved.push(book)
    };

    await scanLibrary(store, paths);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, existing.id);
    assert.equal(saved[0].audioFiles[0].relPath, "audiobooks/Author/Book/01.mp3");
    assert.equal(saved[0].audioFiles[0].title, "Cached Part 1");

    // A file that still exists at its old place isn't treated as moved.
    await fs.mkdir(path.join(paths.libraryDir, "Author/Book"), { recursive: true });
    await fs.copyFile(file, path.join(paths.libraryDir, "Author/Book/01.mp3"));
    await fs.utimes(path.join(paths.libraryDir, "Author/Book/01.mp3"), stat.atime, stat.mtime);
    saved.length = 0;
    await scanLibrary(store, paths, { onlyDirs: ["audiobooks"] });
    assert.notEqual(saved[0].id, existing.id);
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

test("the watcher also watches library folders outside the library root", async () => {
  const { root, paths } = await tempLibrary("shelf-watch-outside-");
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(path.join(elsewhere, "Author"), { recursive: true });
  const reported = [];
  const watcher = createLibraryWatcher({
    libraryDir: paths.libraryDir,
    quietMs: 200,
    onChange: (folders) => reported.push(folders)
  });
  try {
    assert.equal(watcher.start(), true);
    watcher.setExtraRoots([elsewhere]);
    await fs.mkdir(path.join(elsewhere, "Author/New Book"));
    await fs.writeFile(path.join(elsewhere, "Author/New Book/book.epub"), "x");
    for (let i = 0; i < 40 && reported.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(reported, [[path.join(elsewhere, "Author/New Book")]]);
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
