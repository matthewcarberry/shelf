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
      author: "Shelf",
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

test("each library shows the books inside the folder it is assigned", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-library-folders-"));
  const libraryRoot = path.join(workspace, "library");
  await fs.mkdir(path.join(libraryRoot, "ebooks", "Author"), { recursive: true });
  await fs.mkdir(path.join(libraryRoot, "audiobooks"), { recursive: true });
  await fs.mkdir(path.join(libraryRoot, ".hidden"), { recursive: true });
  const store = new SqliteStore(path.join(workspace, "shelfstream.json"));

  try {
    await store.init();
    const owner = await store.createUser({
      username: "owner",
      displayName: "Owner",
      passwordHash: "scrypt:test:test",
      role: "admin"
    });
    const book = (id, relPath, mediaType) => store.upsertBook({
      id,
      title: id,
      author: "Shelf",
      filename: path.basename(relPath),
      relPath,
      ext: path.extname(relPath),
      size: 1,
      status: "ready",
      readingFormat: mediaType === "audiobook" ? "audio" : "epub",
      mediaType,
      addedAt: new Date().toISOString()
    });
    await book("in-ebooks", "ebooks/Author/one.epub", "ebook");
    await book("at-root", "two.epub", "ebook");
    await book("in-audiobooks", "audiobooks/three.m4b", "audiobook");
    await fs.mkdir(path.join(workspace, "data"), { recursive: true });
    const platform = new PlatformService(store, {
      serverIdentity: store.getServerIdentity(),
      serverName: "Test Shelf",
      libraryRoot,
      dataDir: path.join(workspace, "data")
    });
    await platform.init();
    await platform.reconcileBooks(store.listBooks());
    const [books, audiobooks] = platform.listLibraries(owner.id);
    assert.equal(books.itemCount, 2);

    const listing = platform.listLibraryFolders(owner.id);
    assert.equal(listing.parent, workspace);
    assert.equal(listing.selectable, true);
    assert.deepEqual(listing.folders.map((folder) => folder.name), ["audiobooks", "ebooks"]);
    assert.equal(platform.listLibraryFolders(owner.id, "ebooks").parent, path.resolve(libraryRoot));

    await store.setProgress(owner.id, "in-ebooks", { percent: 0.4 });
    const updated = await platform.updateLibrary(owner.id, books.id, { rootPath: path.join(libraryRoot, "ebooks") });
    assert.equal(updated.rootPath, path.join(libraryRoot, "ebooks"));
    assert.equal(updated.itemCount, 1);
    assert.deepEqual(platform.getBookLibraryIds("in-ebooks"), [books.id]);
    assert.deepEqual(platform.getBookLibraryIds("at-root"), []);
    assert.equal(store.getProgress(owner.id, "in-ebooks").percent, 0.4);

    // Relative folders are read from the library root.
    await platform.updateLibrary(owner.id, audiobooks.id, { rootPath: "audiobooks" });
    assert.equal(platform.getLibraryRoot(audiobooks.id), path.join(libraryRoot, "audiobooks"));
    assert.equal(platform.uploadFolderFor("audiobook"), path.join(libraryRoot, "audiobooks"));
    assert.equal(platform.uploadFolderFor("ebook"), path.join(libraryRoot, "ebooks"));

    await assert.rejects(platform.updateLibrary(owner.id, books.id, { rootPath: "missing" }), /Folder not found/);
    await assert.rejects(platform.updateLibrary(owner.id, books.id, { rootPath: "/" }), /can't be used/);
    await assert.rejects(platform.updateLibrary(owner.id, books.id, { rootPath: "/etc" }), /can't be used/);
    await assert.rejects(platform.updateLibrary(owner.id, books.id, { rootPath: path.join(workspace, "data") }), /can't be used/);
    assert.throws(() => platform.listLibraryFolders(owner.id, "/proc"), /can't be used/);
    const top = platform.listLibraryFolders(owner.id, "/");
    assert.equal(top.selectable, false);
    assert.equal(top.parent, null);
    assert.ok(!top.folders.some((folder) => folder.name === "proc" || folder.name === "etc"));

    // A folder outside the library root (another mount) works too.
    const elsewhere = path.join(workspace, "elsewhere");
    await fs.mkdir(path.join(elsewhere, "Author"), { recursive: true });
    await book("outside", path.join(elsewhere, "Author", "four.epub"), "ebook");
    await platform.updateLibrary(owner.id, books.id, { rootPath: elsewhere });
    assert.deepEqual(platform.outsideLibraryRoots(), [elsewhere]);
    assert.deepEqual(platform.getBookLibraryIds("outside"), [books.id]);
    assert.deepEqual(platform.getBookLibraryIds("in-ebooks"), []);
    assert.equal(platform.uploadFolderFor("ebook"), elsewhere);

    // Pointing the library back at the root brings the book back.
    await platform.updateLibrary(owner.id, books.id, { rootPath: libraryRoot });
    assert.deepEqual(platform.getBookLibraryIds("at-root"), [books.id]);
    assert.deepEqual(platform.outsideLibraryRoots(), []);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
