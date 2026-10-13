import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlatformService } from "./platform.js";
import { SqliteStore } from "./store.js";

test("separates accounts, server memberships, invitations, and libraries", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-platform-"));
  const libraryRoot = path.join(workspace, "library");
  await fs.mkdir(libraryRoot, { recursive: true });
  const store = new SqliteStore(path.join(workspace, "shelfstream.json"));

  try {
    await store.init();
    const owner = await store.createUser({
      username: "owner",
      displayName: "Owner",
      passwordHash: "scrypt:test:test",
      role: "admin"
    });
    await store.upsertBook({
      id: "ebook-1",
      title: "Book One",
      author: "ShelfStream",
      filename: "book.epub",
      relPath: "book.epub",
      ext: ".epub",
      size: 1,
      status: "ready",
      readingFormat: "epub",
      mediaType: "ebook",
      addedAt: new Date().toISOString()
    });
    const identity = store.getServerIdentity();
    const platform = new PlatformService(store, {
      serverIdentity: identity,
      serverName: "Test Shelf",
      libraryRoot
    });
    await platform.init();

    assert.equal(platform.getMembership(identity.serverId, owner.id).role, "owner");
    const ownerLibraries = platform.listLibraries(owner.id);
    assert.deepEqual(ownerLibraries.map((library) => library.name), ["Books", "Audiobooks"]);
    const bookLibrary = ownerLibraries.find((library) => library.mediaType === "ebook");
    assert.deepEqual(platform.getBookLibraryIds("ebook-1"), [bookLibrary.id]);

    const joiner = await store.createUser({
      username: "joiner",
      displayName: "Joiner",
      passwordHash: "scrypt:test:test",
      role: "reader"
    });
    platform.ensureAccount(joiner, "joiner@example.com");
    assert.equal(platform.getMembership(identity.serverId, joiner.id), null);

    const invitation = await platform.createInvitation(owner.id, {
      recipient: "joiner@example.com",
      role: "member",
      libraryIds: [bookLibrary.id]
    });
    await platform.acceptInvitation(joiner.id, invitation.token);
    assert.equal(platform.getMembership(identity.serverId, joiner.id).role, "member");
    assert.deepEqual(platform.listLibraries(joiner.id).map((library) => library.id), [bookLibrary.id]);
    assert.equal(platform.canAccessBook(joiner.id, "ebook-1"), true);

    const connection = await platform.createConnectionTicket(joiner.id, identity.serverId);
    const exchanged = await platform.exchangeConnectionTicket(connection.ticket);
    assert.equal(exchanged.accountId, joiner.id);
    assert.equal(exchanged.serverRole, "member");
    assert.equal(exchanged.context.servers[0].serverId, identity.serverId);
    assert.equal(platform.verifyDelegation(exchanged.context.delegation).sub, joiner.id);
    await assert.rejects(
      platform.exchangeConnectionTicket(connection.ticket),
      /already been used/
    );

    const tables = store.sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name);
    assert.equal(tables.includes("friendships"), true);
    assert.equal(tables.includes("server_memberships"), true);
    assert.equal(tables.includes("libraries"), true);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("requires HTTPS for non-local remote server endpoints", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-platform-url-"));
  const libraryRoot = path.join(workspace, "library");
  await fs.mkdir(libraryRoot, { recursive: true });
  const store = new SqliteStore(path.join(workspace, "shelfstream.json"));
  try {
    await store.init();
    const owner = await store.createUser({
      username: "owner",
      displayName: "Owner",
      passwordHash: "scrypt:test:test",
      role: "admin"
    });
    const platform = new PlatformService(store, {
      serverIdentity: store.getServerIdentity(),
      serverName: "Test Shelf",
      libraryRoot
    });
    await platform.init();
    await assert.rejects(
      platform.claimRemoteServer(owner.id, { endpointUrl: "http://example.com", claimCode: "ABC" }),
      /must use HTTPS/
    );
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
