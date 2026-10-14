import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bookFolderName, organizeBook, scanLibrary } from "./library.js";

function memoryStore() {
  const books = new Map();
  return {
    books,
    listBooks: () => [...books.values()],
    getBook: (id) => books.get(id) || null,
    upsertBook: async (book) => books.set(book.id, { ...books.get(book.id), ...book }),
    patchBook: async (id, patch) => {
      books.set(id, { ...books.get(id), ...patch });
      return books.get(id);
    }
  };
}

async function tempLibrary(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  const dataDir = path.join(root, "data");
  return {
    root,
    paths: {
      libraryDir: path.join(root, "library"),
      dataDir,
      convertedDir: path.join(dataDir, "converted"),
      coverDir: path.join(dataDir, "covers")
    }
  };
}

test("names book folders by title and publication year", () => {
  assert.equal(bookFolderName({ title: "A Parade of Horribles", publicationDate: "2026-02-03" }), "A Parade of Horribles (2026)");
  assert.equal(bookFolderName({ title: "Morning Star: Book III of the Red Rising Trilogy", publicationDate: "2016" }), "Morning Star (2016)");
  assert.equal(bookFolderName({ title: "The Score (Off-Campus #3)" }), "The Score");
  assert.equal(bookFolderName({ title: "What? / Why." }), "What Why");
});

test("an organized ebook keeps its ID when the library is scanned again", async () => {
  const { root, paths } = await tempLibrary("shelf-organize-ebook-");
  const store = memoryStore();
  try {
    await fs.mkdir(paths.libraryDir, { recursive: true });
    await fs.writeFile(path.join(paths.libraryDir, "Some Author - Some Book.pdf"), "%PDF-1.4");
    const [scanned] = await scanLibrary(store, paths);
    await store.patchBook(scanned.id, { title: "Some Book", publicationDate: "2019" });

    const { book } = await organizeBook(store, paths, store.getBook(scanned.id));
    assert.equal(book.relPath, "ebooks/Some Book (2019)/Some Author - Some Book.pdf");
    assert.ok(fsSync.existsSync(book.path));
    assert.ok(!fsSync.existsSync(path.join(paths.libraryDir, "Some Author - Some Book.pdf")));

    const rescanned = await scanLibrary(store, paths);
    assert.equal(rescanned.length, 1);
    assert.equal(rescanned[0].id, scanned.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an organized audiobook keeps its ID and removes the folder it left empty", async () => {
  const { root, paths } = await tempLibrary("shelf-organize-audio-");
  const store = memoryStore();
  const sourceDir = path.join(paths.libraryDir, "Some Author", "Some Audiobook");
  try {
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "01.mp3"), "not-real-audio");
    await fs.writeFile(path.join(sourceDir, "02.mp3"), "not-real-audio");
    const [scanned] = await scanLibrary(store, paths);
    assert.equal(scanned.audioFiles.length, 2);

    const { book } = await organizeBook(store, paths, store.getBook(scanned.id));
    assert.deepEqual(
      book.audioFiles.map((track) => track.relPath),
      ["audiobooks/Some Audiobook/01.mp3", "audiobooks/Some Audiobook/02.mp3"]
    );
    assert.ok(!fsSync.existsSync(path.join(paths.libraryDir, "Some Author")));

    const rescanned = await scanLibrary(store, paths);
    assert.equal(rescanned.length, 1);
    assert.equal(rescanned[0].id, scanned.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a file already in the target folder", async () => {
  const { root, paths } = await tempLibrary("shelf-organize-clash-");
  const store = memoryStore();
  try {
    await fs.mkdir(path.join(paths.libraryDir, "ebooks", "Clash"), { recursive: true });
    await fs.writeFile(path.join(paths.libraryDir, "ebooks", "Clash", "clash.pdf"), "existing");
    await fs.writeFile(path.join(paths.libraryDir, "clash.pdf"), "%PDF-1.4");
    const book = (await scanLibrary(store, paths)).find((item) => item.relPath === "clash.pdf");
    await store.patchBook(book.id, { title: "Clash" });

    await assert.rejects(organizeBook(store, paths, store.getBook(book.id)), /already exists/);
    assert.ok(fsSync.existsSync(path.join(paths.libraryDir, "clash.pdf")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
