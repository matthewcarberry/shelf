import crypto from "node:crypto";

const SESSION_COOKIE = "shelfstream_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MOBILE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const ANONYMOUS_USER = {
  id: "anonymous",
  username: "local",
  displayName: "Local reader",
  role: "admin"
};

export function createAuth(store) {
  const enabled = parseBoolean(process.env.AUTH_ENABLED, true);
  const sessions = new Map();

  return {
    enabled,
    async init() {
      if (!enabled || store.hasUsers()) {
        return;
      }

      const username = process.env.APP_USERNAME || "admin";
      const password = process.env.APP_PASSWORD || "";
      const passwordHash = process.env.APP_PASSWORD_HASH || "";

      if (!password && !passwordHash) {
        const message =
          "Authentication is enabled, but no users exist and no APP_PASSWORD or APP_PASSWORD_HASH is configured.";
        if (process.env.NODE_ENV === "production") {
          throw new Error(message);
        }
        console.warn(message);
        return;
      }

      await store.createUser({
        username,
        displayName: username,
        passwordHash: passwordHash || (await hashPassword(password)),
        role: "admin"
      });
    },
    status(req) {
      const { user } = getRequestIdentity(req, store, sessions, enabled);
      return {
        enabled,
        authenticated: !enabled || Boolean(user),
        user: user ? sanitizeUser(user) : null
      };
    },
    middleware(req, res, next) {
      if (!enabled) {
        req.user = ANONYMOUS_USER;
        req.authContext = null;
        next();
        return;
      }

      const { user, context } = getRequestIdentity(req, store, sessions, enabled);
      if (user) {
        req.user = sanitizeUser(user);
        req.authContext = context;
        next();
        return;
      }

      res.status(401).json({ error: "Authentication required" });
    },
    async login(req, res) {
      if (!enabled) {
        res.json({ enabled: false, authenticated: true, user: ANONYMOUS_USER });
        return;
      }

      const submittedUsername = String(req.body?.username || "");
      const submittedPassword = String(req.body?.password || "");
      const user = store.findUserByUsername(submittedUsername);

      if (!user || !(await verifyPassword(submittedPassword, user.passwordHash))) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      const sessionId = crypto.randomBytes(32).toString("base64url");
      issueSession(req, res, sessions, user, sessionId);
      res.json({ enabled: true, authenticated: true, user: sanitizeUser(user) });
    },
    async mobileLogin(req, res) {
      if (!enabled) {
        res.json({ enabled: false, authenticated: true, user: ANONYMOUS_USER, token: "" });
        return;
      }

      const submittedUsername = String(req.body?.username || "");
      const submittedPassword = String(req.body?.password || "");
      const user = store.findUserByUsername(submittedUsername);
      if (!user || !(await verifyPassword(submittedPassword, user.passwordHash))) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      const { token, expiresAt } = await issueMobileToken(store, user, req.body?.deviceName);
      const sessionId = crypto.randomBytes(32).toString("base64url");
      issueSession(req, res, sessions, user, sessionId);
      res.json({
        enabled: true,
        authenticated: true,
        user: sanitizeUser(user),
        token,
        expiresAt
      });
    },
    async issueMobileToken(user, deviceName, context = null) {
      return issueMobileToken(store, user, deviceName, context);
    },
    issueSession(req, res, user, context = null) {
      const sessionId = crypto.randomBytes(32).toString("base64url");
      issueSession(req, res, sessions, user, sessionId, context);
      return { enabled: true, authenticated: true, user: sanitizeUser(user) };
    },
    async logout(req, res) {
      const sessionId = getCookie(req, SESSION_COOKIE);
      if (sessionId) {
        sessions.delete(sessionId);
      }
      const bearerToken = getBearerToken(req);
      if (bearerToken) {
        await store.deleteMobileToken(hashToken(bearerToken));
      }
      clearSessionCookie(req, res);
      res.status(204).end();
    }
  };
}

async function issueMobileToken(store, user, deviceName, context = null) {
  const token = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + MOBILE_TOKEN_TTL_MS).toISOString();
  await store.saveMobileToken(hashToken(token), {
    userId: user.id,
    deviceName: String(deviceName || "ShelfStream mobile").trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    expiresAt,
    context
  });
  return { token, expiresAt };
}

function issueSession(req, res, sessions, user, sessionId, context = null) {
  sessions.set(sessionId, {
    userId: user.id,
    context,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  setSessionCookie(req, res, sessionId);
}

export async function hashPassword(password) {
  if (!password) {
    throw new Error("Password is required");
  }

  const salt = crypto.randomBytes(16).toString("base64url");
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });
  return `scrypt:${salt}:${key.toString("base64url")}`;
}

export async function verifyPassword(password, storedHash) {
  const [prefix, salt, key] = String(storedHash || "").split(":");
  if (prefix !== "scrypt" || !salt || !key) {
    return false;
  }

  const actual = Buffer.from(key, "base64url");
  const expected = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, actual.length, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "Admin access required" });
}

function getRequestIdentity(req, store, sessions, enabled) {
  if (!enabled) {
    return { user: ANONYMOUS_USER, context: null };
  }

  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    const token = store.getMobileToken(hashToken(bearerToken));
    if (!token) {
      return { user: null, context: null };
    }
    if (Date.parse(token.expiresAt) < Date.now()) {
      store.deleteMobileToken(hashToken(bearerToken)).catch(() => undefined);
      return { user: null, context: null };
    }
    return { user: store.getUser(token.userId), context: token.context || null };
  }

  const sessionId = getCookie(req, SESSION_COOKIE);
  if (!sessionId) {
    return { user: null, context: null };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return { user: null, context: null };
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return { user: null, context: null };
  }

  const user = store.getUser(session.userId);
  if (!user) {
    sessions.delete(sessionId);
    return { user: null, context: null };
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { user, context: session.context || null };
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role
  };
}

function setSessionCookie(req, res, sessionId) {
  res.setHeader("Set-Cookie", cookieString(SESSION_COOKIE, sessionId, req, SESSION_TTL_MS));
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", cookieString(SESSION_COOKIE, "", req, 0));
}

function cookieString(name, value, req, maxAgeMs) {
  const secure =
    process.env.COOKIE_SECURE === "true" ||
    req.secure ||
    req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getCookie(req, name) {
  try {
    const header = req.headers.cookie || "";
    const cookies = header.split(";").map((part) => part.trim());
    const prefix = `${name}=`;
    const match = cookies.find((cookie) => cookie.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : "";
  } catch {
    return "";
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
