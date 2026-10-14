import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CAST_LINK_TTL_MS, createCastLinks } from "./cast.js";

test("cast links verify until they expire and reject tampering", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cast-links-"));
  try {
    let clock = 1_000_000;
    const links = createCastLinks(dataDir, { now: () => clock });
    const { token, expiresAt } = links.issue("user-1", "book-1");

    assert.equal(Date.parse(expiresAt), clock + CAST_LINK_TTL_MS);
    assert.deepEqual(links.verify(token), { userId: "user-1", bookId: "book-1", expiresAt: clock + CAST_LINK_TTL_MS });

    // The secret persists in the data folder, so links survive a server restart.
    assert.ok(createCastLinks(dataDir, { now: () => clock }).verify(token));

    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-1", b: "book-2", e: clock + CAST_LINK_TTL_MS })).toString("base64url");
    assert.equal(links.verify(`${forged}.${signature}`), null);
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.equal(links.verify(`${payload}.${flipped}`), null);
    assert.equal(links.verify(payload), null);
    assert.equal(links.verify(""), null);

    clock += CAST_LINK_TTL_MS;
    assert.equal(links.verify(token), null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cast links stream audio and save progress without a sign-in", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cast-"));
  const libraryDir = path.join(workspace, "library");
  const audio = Buffer.alloc(4096, 7);
  await fs.mkdir(path.join(libraryDir, "Cast Test"), { recursive: true });
  await fs.writeFile(path.join(libraryDir, "Cast Test", "01 - Opening.mp3"), audio);
  await fs.writeFile(path.join(libraryDir, "Cast Test", "02 - Closing.mp3"), audio);

  const port = 32000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(workspace, "data"),
      LIBRARY_DIR: libraryDir,
      AUTH_ENABLED: "true",
      APP_USERNAME: "casttest",
      APP_PASSWORD: "shelf-cast-test-password",
      REGISTRATION_ENABLED: "false",
      PUBLIC_URL: `${base}/`,
      CAST_APP_ID: "ABCD1234",
      NODE_ENV: "development"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(base, server);
    const login = await fetch(`${base}/api/auth/mobile/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "casttest", password: "shelf-cast-test-password" })
    });
    const headers = { Authorization: `Bearer ${(await login.json()).token}` };

    const book = await waitForAudiobook(base, headers);
    assert.deepEqual(await (await fetch(`${base}/api/cast/config`, { headers })).json(), { receiverAppId: "ABCD1234" });
    assert.equal((await fetch(`${base}/api/books/${book.id}/cast`, { method: "POST" })).status, 401);

    const cast = await (await fetch(`${base}/api/books/${book.id}/cast`, { method: "POST", headers })).json();
    assert.equal(cast.receiverAppId, "ABCD1234");
    assert.equal(cast.tracks.length, 2);
    assert.equal(cast.coverUrl, null);
    assert.equal(cast.tracks[1].contentType, "audio/mpeg");
    assert.ok(cast.tracks[0].url.startsWith(`${base}/cast/`));
    assert.ok(Date.parse(cast.expiresAt) > Date.now());

    // No cookie or bearer token: the signed link is the only credential.
    const full = await fetch(cast.tracks[0].url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("access-control-allow-origin"), "*");
    assert.equal((await full.arrayBuffer()).byteLength, audio.length);
    const ranged = await fetch(cast.tracks[1].url, { headers: { Range: "bytes=100-199" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(cast.tracks[0].url.replace(/\/audio\/0$/, "/audio/9"))).status, 404);

    const save = await fetch(cast.progressUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIndex: 1, position: 42, duration: 100 })
    });
    assert.equal(save.status, 200);
    const reader = await (await fetch(`${base}/api/books/${book.id}/reader`, { headers })).json();
    assert.equal(reader.progress.trackIndex, 1);
    assert.equal(reader.progress.trackTime, 42);
    assert.equal(
      (await fetch(cast.progressUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
      400
    );

    const tampered = cast.tracks[0].url.replace(/\/cast\/([^/]+)\./, (_match, payload) => `/cast/${payload}x.`);
    assert.equal((await fetch(tampered)).status, 404);
    assert.equal((await fetch(`${base}/cast/not-a-token/audio/0`)).status, 404);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function waitForAudiobook(base, headers) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/api/books`, { headers });
    const body = await response.json();
    const books = Array.isArray(body) ? body : body.books || [];
    const book = books.find((item) => item.readingFormat === "audio");
    if (book) return book;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The test audiobook was never scanned");
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
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Shelf test server did not become healthy");
}
