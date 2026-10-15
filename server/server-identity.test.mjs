import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("publishes the same permanent server identity after restart", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-server-api-"));
  const dataDir = path.join(workspace, "data");
  const libraryDir = path.join(workspace, "library");
  const firstPort = 32000 + Math.floor(Math.random() * 400);
  const secondPort = firstPort + 500;

  try {
    const first = await startTestServer({ dataDir, libraryDir, port: firstPort });
    const firstIdentity = await fetch(`http://127.0.0.1:${firstPort}/.well-known/shelfstream-server`).then(
      (response) => response.json()
    );
    const firstHealth = await fetch(`http://127.0.0.1:${firstPort}/api/health`).then(
      (response) => response.json()
    );
    assert.equal(firstHealth.storage, "sqlite");
    assert.equal(firstHealth.schemaVersion, 6);
    assert.equal(firstHealth.serverId, firstIdentity.serverId);
    assert.equal(firstIdentity.name, "Identity Test Server");
    assert.match(firstIdentity.publicKey, /BEGIN PUBLIC KEY/);
    await stopTestServer(first);

    const second = await startTestServer({ dataDir, libraryDir, port: secondPort });
    try {
      const secondIdentity = await fetch(
        `http://127.0.0.1:${secondPort}/.well-known/shelfstream-server`
      ).then((response) => response.json());
      assert.equal(secondIdentity.serverId, firstIdentity.serverId);
      assert.equal(secondIdentity.publicKey, firstIdentity.publicKey);
    } finally {
      await stopTestServer(second);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function startTestServer({ dataDir, libraryDir, port }) {
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_NAME: "Identity Test Server",
      DATA_DIR: dataDir,
      LIBRARY_DIR: libraryDir,
      AUTH_ENABLED: "false",
      NODE_ENV: "development"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      const stderr = await streamText(server.stderr);
      throw new Error(`Shelf test server exited before becoming healthy: ${stderr}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return server;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopTestServer(server);
  throw new Error("Shelf test server did not become healthy");
}

async function stopTestServer(server) {
  if (server.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
}

async function streamText(stream) {
  let value = "";
  for await (const chunk of stream) {
    value += chunk.toString();
  }
  return value;
}
