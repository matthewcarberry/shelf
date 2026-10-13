import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('mobile bearer tokens authenticate media APIs and can be revoked', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfstream-mobile-auth-'));
  const port = 31000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(workspace, 'data'),
      LIBRARY_DIR: path.join(workspace, 'library'),
      AUTH_ENABLED: 'true',
      APP_USERNAME: 'mobiletest',
      APP_PASSWORD: 'shelfstream-mobile-test-password',
      REGISTRATION_ENABLED: 'false',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(base, server);
    const login = await fetch(`${base}/api/auth/mobile/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: 'mobiletest', password: 'shelfstream-mobile-test-password'}),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.ok(session.token);

    const headers = {Authorization: `Bearer ${session.token}`};
    assert.equal((await fetch(`${base}/api/books`, {headers})).status, 200);
    const webSession = await fetch(`${base}/api/mobile/web-session`, {method: 'POST', headers});
    assert.equal(webSession.status, 204);
    assert.match(webSession.headers.get('set-cookie') || '', /shelfstream_session=/);

    assert.equal((await fetch(`${base}/api/auth/logout`, {method: 'POST', headers})).status, 204);
    assert.equal((await fetch(`${base}/api/books`, {headers})).status, 401);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    await fs.rm(workspace, {recursive: true, force: true});
  }
});

async function waitForHealth(base, server) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error('ShelfStream test server exited before becoming healthy');
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('ShelfStream test server did not become healthy');
}
