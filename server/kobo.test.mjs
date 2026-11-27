import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  createKepubConverter,
  decodeSyncToken,
  encodeSyncToken,
  koboBookId,
  koboBookmarkFromProgress,
  progressFromKoboBookmark,
  readEpubSpine,
  shelfMovedPastKobo,
  spineIndexForSource
} from "./kobo.js";

test("Kobo IDs are stable UUIDs", () => {
  const id = koboBookId("fecd6f243538a31f");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(koboBookId("fecd6f243538a31f"), id);
  assert.notEqual(koboBookId("other"), id);
});

test("sync tokens keep the Kobo store's own token", () => {
  assert.deepEqual(decodeSyncToken("store-token-abc"), { since: null, storeToken: "store-token-abc" });
  assert.deepEqual(decodeSyncToken(""), { since: null, storeToken: null });
  const token = encodeSyncToken({ since: "2026-11-26T10:00:00.000Z", storeToken: "xyz" });
  assert.deepEqual(decodeSyncToken(token), { since: "2026-11-26T10:00:00.000Z", storeToken: "xyz" });
});

test("only real progress in shelf goes back to the Kobo", () => {
  const spine = ["a.xhtml", "b.xhtml", "c.xhtml"];
  const koboState = {
    shelfProgressUpdatedAt: "2026-11-26T10:00:00.000Z",
    StatusInfo: { Status: "Reading" },
    CurrentBookmark: { ProgressPercent: 50, Location: { Source: "b.xhtml" } }
  };
  assert.equal(shelfMovedPastKobo({ percent: 0.5, updatedAt: "2026-11-26T10:00:00.000Z" }, koboState, spine), false);
  assert.equal(shelfMovedPastKobo({ percent: 0.4, locator: "section:1:page:3", updatedAt: "2026-11-26T11:00:00.000Z" }, koboState, spine), false);
  assert.equal(shelfMovedPastKobo({ percent: 0.7, locator: "section:2:page:0", updatedAt: "2026-11-26T11:00:00.000Z" }, koboState, spine), true);
  assert.equal(shelfMovedPastKobo({ percent: 1, locator: "section:1:page:9", updatedAt: "2026-11-26T11:00:00.000Z" }, koboState, spine), true);
  assert.equal(shelfMovedPastKobo({ percent: 0.51, updatedAt: "2026-11-26T11:00:00.000Z" }, koboState, []), false);
  assert.equal(shelfMovedPastKobo({ percent: 0.6, updatedAt: "2026-11-26T11:00:00.000Z" }, koboState, []), true);
  assert.equal(shelfMovedPastKobo({ percent: 0.2, updatedAt: "2026-11-26T11:00:00.000Z" }, null, spine), true);
});

test("Kobo bookmarks map to shelf sections and back", () => {
  const spine = ["OEBPS/Text/cover.xhtml", "OEBPS/Text/ch1.xhtml", "OEBPS/Text/ch2.xhtml", "OEBPS/Text/ch3.xhtml"];
  assert.equal(spineIndexForSource(spine, "OEBPS/Text/ch2.xhtml"), 2);
  assert.equal(spineIndexForSource(spine, "Text/ch2.xhtml"), 2);
  assert.equal(spineIndexForSource(spine, "ch3.xhtml#kobo.4.1"), 3);
  assert.equal(spineIndexForSource(spine, "missing.xhtml"), -1);

  const fromSpan = progressFromKoboBookmark(
    { ProgressPercent: 61, ContentSourceProgressPercent: 40, Location: { Type: "KoboSpan", Value: "kobo.9.2", Source: "OEBPS/Text/ch2.xhtml" } },
    "Reading",
    spine
  );
  assert.deepEqual(fromSpan, { percent: 0.61, locator: "section:2:fraction:0.4" });

  // Plain EPUBs only report a percentage.
  assert.deepEqual(progressFromKoboBookmark({ ProgressPercent: 50 }, "Reading", spine), { percent: 0.5, locator: "section:2:fraction:0" });
  assert.equal(progressFromKoboBookmark({ ProgressPercent: 98 }, "Finished", spine).percent, 1);

  const back = koboBookmarkFromProgress({ percent: 0.6, locator: "section:2:page:3", updatedAt: "2026-11-26T10:00:00.000Z" }, spine, "KEPUB");
  assert.equal(back.ProgressPercent, 60);
  assert.equal(back.ContentSourceProgressPercent, 40);
  assert.deepEqual(back.Location, { Value: "kobo.1.1", Type: "KoboSpan", Source: "OEBPS/Text/ch2.xhtml" });
  assert.equal(back.LastModified, "2026-11-26T10:00:00Z");
  assert.equal(koboBookmarkFromProgress({ percent: 0.6 }, spine, "EPUB").Location, undefined);
});

test("a Kobo syncs the books a reader sends, saves progress back and keeps the Kobo store working", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-kobo-"));
  const libraryDir = path.join(workspace, "library");
  await fs.mkdir(path.join(libraryDir, "Ada Writer", "Test Book"), { recursive: true });
  const epubPath = path.join(libraryDir, "Ada Writer", "Test Book", "Test Book.epub");
  await fs.writeFile(epubPath, await buildEpub());

  const storeCalls = [];
  const fakeStore = http.createServer((req, res) => {
    storeCalls.push({ method: req.method, url: req.url, synctoken: req.headers["x-kobo-synctoken"] || null, authorization: req.headers.authorization || null });
    if (req.url === "/v1/initialization") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        Resources: {
          library_sync: "https://storeapi.kobo.com/v1/library/sync",
          user_profile: "https://storeapi.kobo.com/v1/user/profile",
          reading_services_host: "https://readingservices.kobo.com",
          image_url_template: "https://cdn.kobo.com/book-images/{ImageId}/{Width}/{Height}/false/image.jpg"
        }
      }));
      return;
    }
    if (req.url === "/v1/library/sync") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("x-kobo-synctoken", "store-token-2");
      res.end(JSON.stringify([{ NewEntitlement: { BookEntitlement: { Id: "store-book-1" } } }]));
      return;
    }
    if (req.url === "/v1/user/profile") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ from: "kobo store" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => fakeStore.listen(0, "127.0.0.1", resolve));
  const storeUrl = `http://127.0.0.1:${fakeStore.address().port}`;

  const port = 33000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(workspace, "data"),
      LIBRARY_DIR: libraryDir,
      AUTH_ENABLED: "true",
      APP_USERNAME: "kobotest",
      APP_PASSWORD: "shelf-kobo-test-password",
      REGISTRATION_ENABLED: "false",
      KOBO_STORE_URL: storeUrl,
      KEPUBIFY_PATH: path.join(workspace, "no-kepubify"),
      NODE_ENV: "development"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => (serverOutput += chunk));
  server.stderr.on("data", (chunk) => (serverOutput += chunk));

  try {
    await waitForHealth(base, server);
    const login = await fetch(`${base}/api/auth/mobile/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "kobotest", password: "shelf-kobo-test-password" })
    });
    const headers = { Authorization: `Bearer ${(await login.json()).token}`, "Content-Type": "application/json" };
    const book = await waitForBook(base, headers);
    assert.equal(book.onKobo, false);

    assert.equal((await fetch(`${base}/kobo/${"0".repeat(40)}/v1/initialization`)).status, 401);
    const created = await (await fetch(`${base}/api/kobo/links`, { method: "POST", headers })).json();
    assert.match(created.created.syncUrl, new RegExp(`^${base}/kobo/[a-f0-9]{40}$`));
    assert.equal(created.links.length, 1);
    assert.equal(created.kepub, false);
    const kobo = created.created.syncUrl;
    const device = { Authorization: "Bearer kobo-device-token" };

    // Initialization comes from the store, with store calls and covers pointed back at shelf.
    const init = await (await fetch(`${kobo}/v1/initialization`, { headers: device })).json();
    assert.equal(init.Resources.library_sync, `${kobo}/v1/library/sync`);
    assert.equal(init.Resources.user_profile, `${kobo}/v1/user/profile`);
    assert.equal(init.Resources.reading_services_host, "https://readingservices.kobo.com");
    assert.equal(init.Resources.image_url_template, `${kobo}/{ImageId}/{Width}/{Height}/false/image.jpg`);

    // Anything else is passed through to the store with the device's own credentials.
    const profile = await fetch(`${kobo}/v1/user/profile`, { headers: device });
    assert.deepEqual(await profile.json(), { from: "kobo store" });
    assert.equal(storeCalls.find((call) => call.url === "/v1/user/profile").authorization, "Bearer kobo-device-token");

    // Nothing sent yet: the first sync only has the store's books, and keeps the store's old token.
    let sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": "store-token-1" } });
    let results = await sync.json();
    assert.deepEqual(results, [{ NewEntitlement: { BookEntitlement: { Id: "store-book-1" } } }]);
    assert.equal(storeCalls.filter((call) => call.url === "/v1/library/sync").at(-1).synctoken, "store-token-1");
    let token = sync.headers.get("x-kobo-synctoken");
    assert.equal(decodeSyncToken(token).storeToken, "store-token-2");

    // Send the book; the next sync delivers it.
    assert.deepEqual(await (await fetch(`${base}/api/books/${book.id}/kobo`, { method: "PUT", headers })).json(), { onKobo: true, linked: true });
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    token = sync.headers.get("x-kobo-synctoken");
    assert.equal(storeCalls.filter((call) => call.url === "/v1/library/sync").at(-1).synctoken, "store-token-2");
    const delivered = results.find((item) => item.NewEntitlement?.BookMetadata);
    const koboId = koboBookId(book.id);
    assert.equal(delivered.NewEntitlement.BookEntitlement.Id, koboId);
    assert.equal(delivered.NewEntitlement.BookMetadata.Title, "Test Book");
    assert.deepEqual(delivered.NewEntitlement.BookMetadata.Contributors, [book.author]);
    assert.equal(delivered.NewEntitlement.ReadingState.StatusInfo.Status, "ReadyToRead");
    const download = delivered.NewEntitlement.BookMetadata.DownloadUrls[0];
    assert.equal(download.Format, "EPUB3");
    const file = await fetch(download.Url);
    assert.equal(file.status, 200);
    assert.equal(Buffer.from(await file.arrayBuffer()).length, (await fs.stat(epubPath)).size);
    assert.equal(download.Size, (await fs.stat(epubPath)).size);

    // Unchanged: the next sync has nothing new from shelf.
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    assert.equal(results.filter((item) => JSON.stringify(item).includes(koboId)).length, 0);
    token = sync.headers.get("x-kobo-synctoken");

    // Reading on the Kobo saves progress to shelf at the same chapter.
    const put = await fetch(`${kobo}/v1/library/${koboId}/state`, {
      method: "PUT",
      headers: { ...device, "Content-Type": "application/json" },
      body: JSON.stringify({
        ReadingStates: [{
          EntitlementId: koboId,
          LastModified: "2026-11-26T12:00:00Z",
          StatusInfo: { Status: "Reading", LastModified: "2026-11-26T12:00:00Z" },
          Statistics: { SpentReadingMinutes: 12, RemainingTimeMinutes: 30 },
          CurrentBookmark: {
            ProgressPercent: 55,
            ContentSourceProgressPercent: 25,
            Location: { Type: "KoboSpan", Value: "kobo.3.1", Source: "OEBPS/ch2.xhtml" }
          }
        }]
      })
    });
    assert.equal((await put.json()).RequestResult, "Success");
    let reader = await (await fetch(`${base}/api/books/${book.id}/reader`, { headers })).json();
    assert.equal(reader.progress.percent, 0.55);
    assert.equal(reader.progress.locator, "section:1:fraction:0.25");
    const state = (await (await fetch(`${kobo}/v1/library/${koboId}/state`, { headers: device })).json())[0];
    assert.equal(state.CurrentBookmark.ProgressPercent, 55);
    assert.equal(state.CurrentBookmark.Location.Value, "kobo.3.1");
    assert.equal(state.Statistics.SpentReadingMinutes, 12);

    // The Kobo's own update isn't echoed back to it.
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    assert.equal(results.filter((item) => JSON.stringify(item).includes(koboId)).length, 0);
    token = sync.headers.get("x-kobo-synctoken");

    // Opening the book in shelf saves shelf's own idea of the same spot; that isn't sent back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(`${base}/api/books/${book.id}/progress`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ percent: 0.42, locator: "section:1:page:2" })
    });
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    assert.equal(results.filter((item) => JSON.stringify(item).includes(koboId)).length, 0);
    token = sync.headers.get("x-kobo-synctoken");

    // Reading on into another chapter in shelf reaches the Kobo on its next sync.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(`${base}/api/books/${book.id}/progress`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ percent: 0.8, locator: "section:2:page:0" })
    });
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    const changedState = results.find((item) => item.ChangedReadingState);
    assert.equal(changedState.ChangedReadingState.ReadingState.EntitlementId, koboId);
    assert.equal(changedState.ChangedReadingState.ReadingState.CurrentBookmark.ProgressPercent, 80);
    assert.equal(changedState.ChangedReadingState.ReadingState.StatusInfo.Status, "Reading");
    token = sync.headers.get("x-kobo-synctoken");

    // Covers for store books go to Kobo's image server.
    const storeCover = await fetch(`${kobo}/store-image-id/150/200/false/image.jpg`, { redirect: "manual" });
    assert.equal(storeCover.status, 302);
    assert.equal(storeCover.headers.get("location"), "https://cdn.kobo.com/book-images/store-image-id/150/200/false/image.jpg");

    // Taking the book off the Kobo in shelf removes it on the next sync.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await (await fetch(`${base}/api/books/${book.id}/kobo`, { method: "DELETE", headers })).json(), { onKobo: false, linked: true });
    sync = await fetch(`${kobo}/v1/library/sync`, { headers: { ...device, "x-kobo-synctoken": token } });
    results = await sync.json();
    const removed = results.find((item) => item.ChangedEntitlement?.BookEntitlement?.Id === koboId);
    assert.equal(removed.ChangedEntitlement.BookEntitlement.IsRemoved, true);

    // Removing it on the Kobo works the same way.
    await fetch(`${base}/api/books/${book.id}/kobo`, { method: "PUT", headers });
    assert.equal((await fetch(`${kobo}/v1/library/${koboId}`, { method: "DELETE", headers: device })).status, 204);
    const overview = await (await fetch(`${base}/api/kobo`, { headers })).json();
    assert.deepEqual(overview.bookIds, []);
    assert.ok(overview.links[0].lastUsedAt);

    // Deleting the link stops the Kobo syncing.
    await fetch(`${base}/api/kobo/links/${overview.links[0].id}`, { method: "DELETE", headers });
    assert.equal((await fetch(`${kobo}/v1/library/sync`)).status, 401);
  } catch (error) {
    console.error(serverOutput);
    throw error;
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await new Promise((resolve) => fakeStore.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Kobo copies are converted to kepub once and reused", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-kobo-kepub-"));
  try {
    const source = path.join(workspace, "book.epub");
    await fs.writeFile(source, await buildEpub());
    // Stands in for kepubify: answers --version, and copies the input to --output.
    const fake = path.join(workspace, "fake-kepubify");
    const log = path.join(workspace, "calls.log");
    await fs.writeFile(fake, `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = "--version" ] && exit 0\ncp "$3" "$2"\n`, { mode: 0o755 });
    const converter = createKepubConverter(path.join(workspace, "data"), { binary: fake });
    const book = { id: "book1", ext: ".epub", path: source, mediaType: "ebook", readingFormat: "epub" };

    assert.equal(await converter.isAvailable(), true);
    assert.equal((await converter.fileFor(book, { convertIfMissing: false })).format, "EPUB");
    const first = await converter.fileFor(book);
    assert.equal(first.format, "KEPUB");
    assert.match(first.path, /book1-[0-9a-f]{12}\.kepub\.epub$/);
    assert.equal(first.sourcePath, source);
    const again = await converter.fileFor(book);
    assert.equal(again.path, first.path);
    const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
    assert.equal(calls.filter((line) => line.startsWith("--output")).length, 1);

    const broken = createKepubConverter(path.join(workspace, "data2"), { binary: path.join(workspace, "missing") });
    assert.equal((await broken.fileFor(book)).format, "EPUB");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("the spine reader follows the package order", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-kobo-spine-"));
  try {
    const file = path.join(workspace, "book.epub");
    await fs.writeFile(file, await buildEpub());
    assert.deepEqual(await readEpubSpine(file), ["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml", "OEBPS/ch3.xhtml"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function buildEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:creator>Ada Writer</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item href="ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`);
  for (const n of [1, 2, 3]) {
    zip.file(`OEBPS/ch${n}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body><h1>Chapter ${n}</h1><p>${"Words. ".repeat(200)}</p></body></html>`);
  }
  zip.file("OEBPS/style.css", "body { margin: 0 }");
  return zip.generateAsync({ type: "nodebuffer" });
}

async function waitForBook(base, headers) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await (await fetch(`${base}/api/books`, { headers })).json();
    const book = (body.books || []).find((item) => item.ext === ".epub");
    if (book) return book;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The test EPUB was never scanned");
}

async function waitForHealth(base, server) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error("Shelf test server exited before becoming healthy");
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Shelf test server never became healthy");
}
