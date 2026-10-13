import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('COOKIE_SECURE only marks cookies Secure for HTTPS or proxied requests', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-cookie-secure-'));
  const port = 32000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(workspace, 'data'),
      LIBRARY_DIR: path.join(workspace, 'library'),
      AUTH_ENABLED: 'true',
      APP_USERNAME: 'cookietest',
      APP_PASSWORD: 'shelf-cookie-test-password',
      REGISTRATION_ENABLED: 'false',
      TRUST_PROXY: 'true',
      COOKIE_SECURE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const login = (headers = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify({username: 'cookietest', password: 'shelf-cookie-test-password'}),
    });

  try {
    await waitForHealth(base, server);

    const direct = await login();
    assert.equal(direct.status, 200);
    const directCookie = direct.headers.get('set-cookie') || '';
    assert.match(directCookie, /shelfstream_session=/);
    assert.doesNotMatch(directCookie, /Secure/);
    const cookie = directCookie.split(';')[0];
    assert.equal((await fetch(`${base}/api/books`, {headers: {Cookie: cookie}})).status, 200);

    const viaHttps = await login({'X-Forwarded-Proto': 'https'});
    assert.match(viaHttps.headers.get('set-cookie') || '', /; Secure/);

    const viaHttpProxy = await login({'X-Forwarded-Proto': 'http'});
    assert.match(viaHttpProxy.headers.get('set-cookie') || '', /; Secure/);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    await fs.rm(workspace, {recursive: true, force: true});
  }
});

async function waitForHealth(base, server) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error('Shelf test server exited before becoming healthy');
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Shelf test server did not become healthy');
}
