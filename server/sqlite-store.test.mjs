import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "./store.js";

test("imports the legacy JSON store into SQLite without losing user state", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-sqlite-migration-"));
  const legacyFile = path.join(workspace, "shelfstream.json");
  const fixture = legacyFixture();
  await fs.writeFile(legacyFile, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  const store = new SqliteStore(legacyFile);
  try {
    await store.init();

    assert.equal(store.listUsers().length, 1);
    assert.equal(store.listBooks().length, 1);
    assert.deepEqual(store.getProgress("user-1", "book-1"), fixture.progress["user-1"]["book-1"]);
    assert.equal(store.listBookmarks("user-1", "book-1").length, 1);
    assert.equal(store.listHighlights("user-1", "book-1").length, 1);
    assert.equal(store.getReview("user-1", "book-1").rating, 5);
    assert.equal(store.getPreferences("user-1").theme, "night");
    assert.deepEqual(store.getMobileToken("token-hash"), fixture.mobileTokens["token-hash"]);

    const backup = await fs.readFile(`${legacyFile}.pre-sqlite-backup`, "utf8");
    assert.deepEqual(JSON.parse(backup), fixture);
    assert.deepEqual(JSON.parse(await fs.readFile(legacyFile, "utf8")), fixture);

    const sqlite = new DatabaseSync(path.join(workspace, "shelfstream.sqlite"), { readOnly: true });
    assert.equal(sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM books").get().count, 1);
    assert.equal(sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 4);
    sqlite.close();
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("persists profile usage and a user's Read List across restarts", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-profile-state-"));
  const legacyFile = path.join(workspace, "shelfstream.json");
  const first = new SqliteStore(legacyFile);

  try {
    await first.init();
    const user = await first.createUser({
      username: "profile-reader",
      displayName: "Profile Reader",
      passwordHash: "scrypt:test:test",
      role: "reader"
    });
    await first.upsertBook({
      id: "profile-book",
      title: "Profile Book",
      author: "Shelf",
      filename: "profile.epub",
      relPath: "profile.epub",
      ext: ".epub",
      size: 1,
      status: "ready",
      readingFormat: "epub",
      mediaType: "ebook",
      addedAt: new Date().toISOString()
    });
    await first.recordProfileUsage(user.id, "ebook", 61);
    await first.recordProfileUsage(user.id, "audiobook", 30);
    await first.addToReadList(user.id, "profile-book");

    assert.deepEqual(first.getProfileUsage(user.id), {
      readingSeconds: 61,
      listeningSeconds: 30,
      updatedAt: first.getProfileUsage(user.id).updatedAt
    });
    assert.equal(first.listReadList(user.id)[0].bookId, "profile-book");
    first.close();

    const second = new SqliteStore(legacyFile);
    await second.init();
    try {
      assert.equal(second.getProfileUsage(user.id).readingSeconds, 61);
      assert.equal(second.getProfileUsage(user.id).listeningSeconds, 30);
      assert.equal(second.listReadList(user.id).length, 1);
      await second.deleteBook("profile-book");
      assert.equal(second.listReadList(user.id).length, 0);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("keeps one Ed25519 identity and SQLite state across restarts", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-server-identity-"));
  const legacyFile = path.join(workspace, "shelfstream.json");
  const first = new SqliteStore(legacyFile);

  try {
    await first.init();
    const firstIdentity = first.getServerIdentity();
    assert.match(firstIdentity.serverId, /^srv_[A-Za-z0-9_-]{24}$/);
    assert.match(firstIdentity.publicKey, /BEGIN PUBLIC KEY/);
    assert.match(firstIdentity.privateKey, /BEGIN PRIVATE KEY/);

    const message = Buffer.from("shelfstream-server-identity");
    const signature = crypto.sign(null, message, crypto.createPrivateKey(firstIdentity.privateKey));
    assert.equal(crypto.verify(null, message, crypto.createPublicKey(firstIdentity.publicKey), signature), true);

    await first.createUser({
      username: "owner",
      displayName: "Owner",
      passwordHash: "scrypt:test:test",
      role: "admin"
    });
    const userId = first.listUsers()[0].id;
    await first.setProgress(userId, "book-1", { percent: 0.42, currentTime: 120 });
    first.close();

    const second = new SqliteStore(legacyFile);
    await second.init();
    try {
      const secondIdentity = second.getServerIdentity();
      assert.equal(secondIdentity.serverId, firstIdentity.serverId);
      assert.equal(secondIdentity.publicKey, firstIdentity.publicKey);
      assert.equal(secondIdentity.privateKey, firstIdentity.privateKey);
      assert.equal(second.getProgress(userId, "book-1").percent, 0.42);
      assert.equal(second.getPublicServerIdentity().privateKey, undefined);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("leaves a corrupt legacy database untouched when migration fails", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-sqlite-failure-"));
  const legacyFile = path.join(workspace, "shelfstream.json");
  const corrupt = "{ definitely not valid json";
  await fs.writeFile(legacyFile, corrupt, "utf8");
  const store = new SqliteStore(legacyFile);

  try {
    await assert.rejects(store.init(), /JSON/);
    assert.equal(await fs.readFile(legacyFile, "utf8"), corrupt);
    const files = await fs.readdir(workspace);
    assert.equal(files.includes("shelfstream.sqlite"), false);
    assert.equal(files.some((name) => name.startsWith("shelfstream.sqlite.failed-")), true);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function legacyFixture() {
  const timestamp = "2026-08-26T12:00:00.000Z";
  return {
    books: {
      "book-1": {
        id: "book-1",
        title: "Migration Test",
        author: "Shelf",
        addedAt: timestamp,
        updatedAt: timestamp
      }
    },
    users: {
      "user-1": {
        id: "user-1",
        username: "reader",
        displayName: "Reader",
        passwordHash: "scrypt:test:test",
        role: "reader",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    progress: {
      "user-1": {
        "book-1": { percent: 0.35, trackIndex: 2, trackTime: 45, updatedAt: timestamp }
      }
    },
    bookmarks: {
      "user-1": {
        "book-1": [{ id: "bookmark-1", userId: "user-1", bookId: "book-1", percent: 0.2 }]
      }
    },
    highlights: {
      "user-1": {
        "book-1": [{ id: "highlight-1", userId: "user-1", bookId: "book-1", text: "Text" }]
      }
    },
    preferences: { "user-1": { theme: "night" } },
    reviews: {
      "user-1": {
        "book-1": { id: "review-1", userId: "user-1", bookId: "book-1", rating: 5, updatedAt: timestamp }
      }
    },
    dictionaryCache: { test: { result: { word: "test" }, cachedAt: timestamp } },
    mobileTokens: {
      "token-hash": { userId: "user-1", deviceName: "Phone", expiresAt: "2099-01-01T00:00:00.000Z" }
    }
  };
}
