import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filterDuplicateUploads, scanLibrary } from "./library.js";

test("reuses unchanged audiobook track metadata and preserves the title identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-audio-cache-"));
  const libraryDir = path.join(root, "library");
  const dataDir = path.join(root, "data");
  const audiobookDir = path.join(libraryDir, "A Cached Audiobook");
  const trackPath = path.join(audiobookDir, "01 - Opening.mp3");
  await fs.mkdir(audiobookDir, { recursive: true });
  await fs.writeFile(trackPath, "not-real-audio");

  const existing = {
    id: "existing-audiobook-id",
    title: "A Cached Audiobook",
    author: "Shelf QA",
    readingFormat: "audio",
    mediaType: "audiobook",
    audioFiles: [{
      path: trackPath,
      relPath: "A Cached Audiobook/01 - Opening.mp3",
      filename: "01 - Opening.mp3",
      title: "Opening",
      durationSeconds: 123
    }]
  };
  const saved = [];
  const store = {
    listBooks: () => [existing],
    getBook: (id) => id === existing.id ? existing : null,
    upsertBook: async (book) => saved.push(book)
  };

  try {
    const books = await scanLibrary(store, {
      libraryDir,
      dataDir,
      convertedDir: path.join(dataDir, "converted"),
      coverDir: path.join(dataDir, "covers")
    });
    assert.equal(books.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, existing.id);
    assert.equal(saved[0].audioFiles[0].title, "Opening");
    assert.equal(saved[0].audioFiles[0].durationSeconds, 123);
    assert.equal(saved[0].audioFiles[0].size, 14);
    assert.ok(Number.isFinite(saved[0].audioFiles[0].modifiedMs));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("groups untagged audio files from one upload into a single audiobook", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-audio-batch-"));
  const libraryDir = path.join(root, "library");
  const dataDir = path.join(root, "data");
  const filenames = [
    "Bram Stoker - Dracula (Audible) Unabridged Part 1 01.mp3",
    "Bram Stoker - Dracula (Audible) Unabridged Part 1 02.mp3",
    "Bram Stoker - Dracula (Audible) Unabridged Part 2 01.mp3"
  ];
  await fs.mkdir(libraryDir, { recursive: true });
  await Promise.all(filenames.map((filename) => fs.writeFile(path.join(libraryDir, filename), "not-real-audio")));

  const books = new Map();
  const store = {
    listBooks: () => [...books.values()],
    getBook: (id) => books.get(id) || null,
    upsertBook: async (book) => books.set(book.id, book)
  };

  try {
    const scanned = await scanLibrary(store, {
      libraryDir,
      dataDir,
      convertedDir: path.join(dataDir, "converted"),
      coverDir: path.join(dataDir, "covers")
    }, {
      audioBatchKey: "test-upload",
      audioBatchPaths: filenames
    });

    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].mediaType, "audiobook");
    assert.equal(scanned[0].audioFiles.length, 3);
    assert.deepEqual(scanned[0].audioFiles.map((track) => track.filename), filenames);
    assert.deepEqual(scanned[0].audioFiles.map((track) => track.disc), [1, 1, 2]);
    assert.equal(scanned[0].title, "Dracula (Audible) Unabridged");
    assert.equal(scanned[0].author, "Bram Stoker");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removes a byte-identical retry while preserving the original upload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-upload-dedupe-"));
  const canonicalPath = path.join(root, "Chapter 01.mp3");
  const retryPath = path.join(root, "Chapter 01-1.mp3");
  await fs.writeFile(canonicalPath, "identical-audio");
  await fs.writeFile(retryPath, "identical-audio");

  try {
    const result = await filterDuplicateUploads([{
      originalname: "Chapter 01.mp3",
      path: retryPath,
      shelfstreamCanonicalPath: canonicalPath
    }]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.duplicates, ["Chapter 01.mp3"]);
    await fs.access(canonicalPath);
    await assert.rejects(fs.access(retryPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
