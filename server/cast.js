import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";

// A Chromecast fetches audio itself, without the browser's sign-in cookie, so casting
// hands it signed links scoped to one user and one book that expire after a day.
export const CAST_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export function createCastLinks(dataDir, { now = () => Date.now() } = {}) {
  const secret = loadSecret(path.join(dataDir, "cast-secret"));

  function sign(payload) {
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  }

  return {
    issue(userId, bookId) {
      const expiresAt = now() + CAST_LINK_TTL_MS;
      const payload = Buffer.from(JSON.stringify({ u: userId, b: bookId, e: expiresAt })).toString("base64url");
      return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(expiresAt).toISOString() };
    },
    verify(token) {
      const [payload, signature, extra] = String(token || "").split(".");
      if (!payload || !signature || extra !== undefined) {
        return null;
      }
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return null;
      }
      let claims;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (!claims?.u || !claims?.b || !Number.isFinite(claims.e) || claims.e <= now()) {
        return null;
      }
      return { userId: claims.u, bookId: claims.b, expiresAt: claims.e };
    }
  };
}

function loadSecret(filePath) {
  try {
    const existing = fsSync.readFileSync(filePath);
    if (existing.length >= 32) {
      return existing;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const secret = crypto.randomBytes(48);
  fsSync.writeFileSync(filePath, secret, { mode: 0o600 });
  return secret;
}
