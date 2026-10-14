import express from "express";
import mime from "mime-types";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import sanitize from "sanitize-filename";
import { fileURLToPath } from "node:url";
import { SqliteStore, normalizeUsername } from "./store.js";
import {
  ALL_BOOK_EXTENSIONS,
  AUDIO_EXTENSIONS,
  convertBook,
  decorateBook,
  ensureStorage,
  filterDuplicateUploads,
  getAudioTracks,
  getPaths,
  getReadingFile,
  scanLibrary,
  streamFile
} from "./library.js";
import { lookupDefinition } from "./dictionary.js";
import { createAuth, hashPassword, requireAdmin, verifyPassword } from "./auth.js";
import { notifyRegistrationAttempt, registrationNotificationsConfigured } from "./notifications.js";
import { kindleDeliverySettings, sendBookToKindle } from "./kindle.js";
import { ActivityTracker } from "./activity.js";
import { PlatformService } from "./platform.js";
import { downloadOpenLibraryCover, searchOpenLibraryArtwork } from "./artwork.js";
import { createCastLinks } from "./cast.js";
import { LibbyService, parseLibbyBookId } from "./libby.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const paths = getPaths();
const store = new SqliteStore(paths.dbFile);
const conversionJobs = new Map();
const registrationAttempts = new Map();
const activityTracker = new ActivityTracker();
let initialLibraryScanStatus = "pending";
const registrationEnabled = parseBoolean(process.env.REGISTRATION_ENABLED, true);
const registrationRequireEmailNotify = parseBoolean(
  process.env.REGISTRATION_REQUIRE_EMAIL_NOTIFY,
  process.env.NODE_ENV === "production"
);
const registrationWindowMs = Number(process.env.REGISTRATION_WINDOW_MS || 15 * 60 * 1000);
const registrationMaxAttempts = Number(process.env.REGISTRATION_MAX_ATTEMPTS || 5);

await ensureStorage(paths);
await store.init();
const serverIdentity = store.getPublicServerIdentity();
const storageInfo = store.getStorageInfo();
// Servers configured before the rename still pass the old product name; show it as Shelf.
const LEGACY_SERVER_NAMES = new Map([["shelfstream", "Shelf"], ["shelfstream server", "Shelf Server"]]);
const configuredServerName = String(process.env.SERVER_NAME || os.hostname()).trim() || "Shelf Server";
const serverName = LEGACY_SERVER_NAMES.get(configuredServerName.toLowerCase()) || configuredServerName;
const auth = createAuth(store);
await auth.init();
const platform = new PlatformService(store, {
  serverIdentity: store.getServerIdentity(),
  serverName,
  libraryRoot: paths.libraryDir,
  publicUrl: process.env.PUBLIC_URL || ""
});
await platform.init();
const castLinks = createCastLinks(paths.dataDir);
const libby = new LibbyService(store, paths.dataDir);
// The Google Cast application ID for Shelf's own TV screen; without it senders use Google's default receiver.
const castReceiverAppId = String(process.env.CAST_APP_ID || "").trim() || null;

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fsSync.mkdirSync(paths.libraryDir, { recursive: true });
      cb(null, paths.libraryDir);
    },
    filename(_req, file, cb) {
      const sanitized = sanitize(file.originalname) || `book-${Date.now()}`;
      file.shelfstreamCanonicalPath = path.join(paths.libraryDir, sanitized);
      cb(null, uniqueFilename(paths.libraryDir, sanitized));
    }
  })
});
const coverMimeExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024 }
});

const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", true);
}
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Shelf",
    serverId: serverIdentity.serverId,
    storage: storageInfo.engine,
    schemaVersion: storageInfo.schemaVersion,
    libraryScan: initialLibraryScanStatus
  });
});

app.get("/.well-known/shelfstream-server", (_req, res) => {
  res.json({
    protocol: "shelfstream",
    apiVersion: 1,
    serverId: serverIdentity.serverId,
    name: serverName,
    publicKey: serverIdentity.publicKey,
    capabilities: [
      "ebooks",
      "audiobooks",
      "offline",
      "progress",
      "multi-user",
      "libraries",
      "invitations",
      "connection-tickets",
      "server-scoped-sync"
    ]
  });
});

app.get("/api/auth/status", (req, res) => {
  const registrationNotificationsReady =
    !registrationRequireEmailNotify || registrationNotificationsConfigured();
  const canRegister = auth.enabled && registrationEnabled && registrationNotificationsReady;

  res.json({
    ...auth.status(req),
    registrationEnabled: canRegister,
    registrationDisabledReason: getRegistrationDisabledReason(registrationNotificationsReady)
  });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    await auth.login(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/mobile/login", async (req, res, next) => {
  try {
    await auth.mobileLogin(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  const attempt = registrationAttemptEvent(req, req.body || {});
  try {
    if (!auth.enabled || !registrationEnabled) {
      attempt.status = "blocked";
      attempt.reason = "registration disabled";
      res.status(404).json({ error: "Registration is not available" });
      return;
    }

    if (registrationRequireEmailNotify && !registrationNotificationsConfigured()) {
      attempt.status = "blocked";
      attempt.reason = "registration notifications not configured";
      res.status(503).json({ error: "Registration notifications are not configured" });
      return;
    }

    const rateLimit = checkRegistrationRateLimit(req);
    if (!rateLimit.allowed) {
      attempt.status = "blocked";
      attempt.reason = "rate limited";
      console.warn(`Registration rate limited: ${JSON.stringify(attempt)}`);
      res.status(429).json({ error: "Too many registration attempts. Try again later." });
      return;
    }

    if (String(req.body?.website || "").trim()) {
      attempt.status = "blocked";
      attempt.reason = "spam trap";
      res.status(400).json({ error: "Registration failed" });
      return;
    }

    const username = normalizeUsername(req.body?.username);
    const displayName = String(req.body?.displayName || username).trim().slice(0, 80);
    const password = String(req.body?.password || "");
    const passwordConfirm = String(req.body?.passwordConfirm || "");
    attempt.username = username;
    attempt.displayName = displayName;

    if (!username || username.length < 3) {
      attempt.status = "failed";
      attempt.reason = "invalid username";
      res.status(400).json({ error: "Username must be at least 3 letters or numbers" });
      return;
    }

    if (password.length < 10) {
      attempt.status = "failed";
      attempt.reason = "weak password";
      res.status(400).json({ error: "Password must be at least 10 characters" });
      return;
    }

    if (password !== passwordConfirm) {
      attempt.status = "failed";
      attempt.reason = "password mismatch";
      res.status(400).json({ error: "Passwords do not match" });
      return;
    }

    if (store.findUserByUsername(username)) {
      attempt.status = "failed";
      attempt.reason = "username already exists";
      res.status(409).json({ error: "Username already exists" });
      return;
    }

    const user = await store.createUser({
      username,
      displayName,
      passwordHash: await hashPassword(password),
      role: "reader"
    });
    platform.ensureAccount(user, req.body?.email);
    attempt.status = "created";
    attempt.reason = "Shelf account created; server invite required";
    res.status(201).json(auth.issueSession(req, res, user));
  } catch (error) {
    attempt.status = "failed";
    attempt.reason = error?.message || "registration error";
    next(error);
  } finally {
    if (attempt.status !== "blocked" || attempt.reason !== "rate limited") {
      notifyRegistrationAttempt(attempt).catch((error) => {
        console.error("Unable to send registration notification", error);
      });
    }
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  const user = auth.status(req).user;
  if (user) {
    activityTracker.remove(user.id);
  }
  try {
    await auth.logout(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/exchange", async (req, res, next) => {
  try {
    const exchanged = await platform.exchangeConnectionTicket(req.body?.ticket);
    const session = auth.issueSession(req, res, exchanged.user, exchanged.context);
    if (String(req.headers.accept || "").includes("text/html") || req.body?.redirect === true) {
      res.redirect(303, "/");
      return;
    }
    res.json({ ...session, accountId: exchanged.accountId, serverRole: exchanged.serverRole });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/mobile/exchange", async (req, res, next) => {
  try {
    const exchanged = await platform.exchangeConnectionTicket(req.body?.ticket);
    const issued = await auth.issueMobileToken(exchanged.user, req.body?.deviceName, exchanged.context);
    res.json({
      ...issued,
      user: exchanged.user,
      accountId: exchanged.accountId,
      serverRole: exchanged.serverRole,
      serverId: serverIdentity.serverId,
      serverName
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/server/claim", async (req, res, next) => {
  try {
    const result = await platform.claimLocalServer(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/platform/delegated/ticket", async (req, res, next) => {
  try {
    const delegation = platform.verifyDelegation(req.body?.delegation);
    res.json(await platform.createConnectionTicket(delegation.sub, String(req.body?.serverId || "")));
  } catch (error) {
    next(error);
  }
});

// Cast links: public routes the Chromecast calls with a signed token instead of a sign-in.
app.use("/cast/:token", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const claims = castLinks.verify(req.params.token);
  const user = claims ? castLinkUser(claims.userId) : null;
  const book = user ? store.getBook(claims.bookId) : null;
  if (
    !book ||
    book.readingFormat !== "audio" ||
    !platform.getMembership(serverIdentity.serverId, user.id) ||
    !platform.canAccessBook(user.id, book.id)
  ) {
    res.status(404).json({ error: "Cast link is invalid or has expired" });
    return;
  }
  req.castUser = user;
  req.castBook = book;
  next();
});

app.get("/cast/:token/audio/:trackIndex", (req, res) => {
  const trackIndex = Number.parseInt(req.params.trackIndex, 10);
  const track = Number.isInteger(trackIndex) ? req.castBook.audioFiles?.[trackIndex] : null;
  if (!track) {
    res.status(404).json({ error: "Audio track not found" });
    return;
  }
  streamFile(req, res, track.path, "audio/mpeg");
});

app.get("/cast/:token/cover", (req, res) => {
  if (!req.castBook.coverPath) {
    res.status(404).json({ error: "Cover not found" });
    return;
  }
  streamFile(req, res, req.castBook.coverPath, req.castBook.coverMime || "image/jpeg");
});

app.put("/cast/:token/progress", async (req, res, next) => {
  try {
    const update = audioProgressUpdate(req.castBook, req.body?.trackIndex, req.body?.position, req.body?.duration);
    if (!update) {
      res.status(400).json({ error: "Invalid audiobook progress update" });
      return;
    }
    const progress = await store.setProgress(req.castUser.id, req.castBook.id, update);
    res.json({ progress });
  } catch (error) {
    next(error);
  }
});

function castLinkUser(userId) {
  if (!auth.enabled) {
    return userId === "anonymous" ? { id: "anonymous" } : null;
  }
  return store.getUser(userId) || null;
}

app.use("/api", (req, res, next) => {
  auth.middleware(req, res, next);
});

app.get("/api/platform", (req, res, next) => {
  try {
    res.json(platform.overviewFromContext(req.user.id, req.authContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/platform/invitations/accept", async (req, res, next) => {
  try {
    res.json(await platform.acceptInvitation(req.user.id, req.body?.token));
  } catch (error) {
    next(error);
  }
});

app.post("/api/platform/servers/claim", async (req, res, next) => {
  try {
    res.json(await platform.claimRemoteServer(req.user.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/platform/preferences", (req, res) => {
  res.json({ preferences: platform.getAccountPreferences(req.user.id) });
});

app.put("/api/platform/preferences", async (req, res, next) => {
  try {
    const preferences = await platform.setAccountPreferences(req.user.id, req.body || {});
    res.json({ preferences });
  } catch (error) {
    next(error);
  }
});

app.get("/api/platform/servers/:serverId/ticket", async (req, res, next) => {
  try {
    if (req.authContext?.delegation && req.params.serverId !== serverIdentity.serverId) {
      res.json(await platform.requestDelegatedConnectionTicket(req.authContext, req.params.serverId));
      return;
    }
    res.json(await platform.createConnectionTicket(req.user.id, req.params.serverId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/platform/members", (req, res, next) => {
  try {
    res.json({ members: platform.listMembers(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/platform/members/:accountId", async (req, res, next) => {
  try {
    const member = await platform.updateMember(req.user.id, req.params.accountId, req.body || {});
    res.json({ member });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/platform/members/:accountId", async (req, res, next) => {
  try {
    const removed = await platform.removeMember(req.user.id, req.params.accountId);
    if (!removed) {
      res.status(404).json({ error: "Server member not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/platform/invitations", (req, res, next) => {
  try {
    res.json({ invitations: platform.listInvitations(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/platform/invitations", async (req, res, next) => {
  try {
    const invitation = await platform.createInvitation(req.user.id, req.body || {});
    res.status(201).json({ invitation });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/platform/invitations/:invitationId", async (req, res, next) => {
  try {
    const removed = await platform.revokeInvitation(req.user.id, req.params.invitationId);
    if (!removed) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/platform/claim-code", async (req, res, next) => {
  try {
    res.json(await platform.createClaimCode(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/platform/server", async (req, res, next) => {
  try {
    res.json(await platform.setEndpoint(req.user.id, req.body?.endpointUrl));
  } catch (error) {
    next(error);
  }
});

app.get("/api/libraries", (req, res) => {
  res.json({ libraries: platform.listLibraries(req.user.id) });
});

app.post("/api/libraries", async (req, res, next) => {
  try {
    const library = await platform.createLibrary(req.user.id, req.body || {});
    res.status(201).json({ library });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/libraries/:libraryId", async (req, res, next) => {
  try {
    const library = await platform.updateLibrary(req.user.id, req.params.libraryId, req.body || {});
    res.json({ library });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/libraries/:libraryId", async (req, res, next) => {
  try {
    await platform.deleteLibrary(req.user.id, req.params.libraryId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/platform") || req.path.startsWith("/auth") || req.path.startsWith("/me")) {
    next();
    return;
  }
  const membership = platform.getMembership(serverIdentity.serverId, req.user.id);
  if (!membership) {
    res.status(403).json({ error: "Join this Shelf server with an invitation before opening its libraries" });
    return;
  }
  req.serverMembership = membership;
  next();
});

app.get("/api/libby", (req, res) => {
  res.json(libby.status(req.user.id));
});

app.post("/api/libby/link", async (req, res, next) => {
  try {
    res.json(await libby.link(req.user.id, req.body?.code));
  } catch (error) {
    next(error);
  }
});

app.post("/api/libby/link/start", async (req, res, next) => {
  try {
    res.json(await libby.startLink(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/libby/link/check", async (req, res, next) => {
  try {
    res.json(await libby.checkLink(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/libby/link", async (req, res, next) => {
  try {
    await libby.unlink(req.user.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/libby/loans", async (req, res, next) => {
  try {
    const books = await libby.loans(req.user.id, { force: req.query.refresh === "1" });
    res.json({ ...libby.status(req.user.id), books });
  } catch (error) {
    next(error);
  }
});

// Libby loans use the same /api/books/:bookId routes as library books, so the reader and
// player work unchanged. They belong to one user and never touch the shared library.
const libbyBooks = express.Router({ mergeParams: true });

libbyBooks.use(async (req, res, next) => {
  try {
    const found = await libby.findLoan(req.user.id, req.params.bookId);
    if (!found) {
      res.status(404).json({ error: "This Libby loan has ended or was returned" });
      return;
    }
    req.libbyLoan = found.loan;
    req.libbyBook = found.book;
    next();
  } catch (error) {
    next(error);
  }
});

libbyBooks.get("/", (req, res) => {
  res.json({ book: req.libbyBook });
});

libbyBooks.get("/reader", async (req, res, next) => {
  try {
    const book = req.libbyBook;
    const mode = book.libby.mode;
    let audioTracks = [];
    if (mode === "audio") {
      const session = await libby.audioSession(req.user.id, req.libbyLoan);
      audioTracks = session.tracks.map(({ upstreamUrl: _upstreamUrl, ...track }) => ({
        ...track,
        fileUrl: `/api/books/${book.id}/audio/${track.index}`
      }));
      book.trackCount = audioTracks.length;
      book.durationSeconds = audioTracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0) || null;
    }
    res.json({
      book,
      fileUrl: mode === "epub" || mode === "pdf" ? `/api/books/${book.id}/file` : null,
      format: book.readingFormat,
      audioTracks,
      progress: store.getProgress(req.user.id, book.id),
      bookmarks: store.listBookmarks(req.user.id, book.id),
      highlights: store.listHighlights(req.user.id, book.id),
      preferences: store.getPreferences(req.user.id),
      myReview: null,
      reviews: []
    });
  } catch (error) {
    next(error);
  }
});

libbyBooks.get("/file", async (req, res, next) => {
  try {
    const mode = req.libbyBook.libby.mode;
    if (mode !== "epub" && mode !== "pdf") {
      res.status(409).json({ error: "This loan opens in Libby" });
      return;
    }
    const filePath = await libby.openFilePath(req.user.id, req.libbyLoan, mode);
    streamFile(req, res, filePath, mode === "pdf" ? "application/pdf" : "application/epub+zip");
  } catch (error) {
    next(error);
  }
});

libbyBooks.get("/audio/:trackIndex", async (req, res, next) => {
  try {
    if (req.libbyBook.libby.mode !== "audio") {
      res.status(404).json({ error: "Audiobook not found" });
      return;
    }
    await libby.streamAudio(req, res, req.user.id, req.libbyLoan, Number.parseInt(req.params.trackIndex, 10));
  } catch (error) {
    next(error);
  }
});

libbyBooks.put("/progress", async (req, res, next) => {
  try {
    res.json({ progress: await store.setProgress(req.user.id, req.libbyBook.id, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

libbyBooks.post("/bookmarks", async (req, res, next) => {
  try {
    res.status(201).json({ bookmark: await store.addBookmark(req.user.id, req.libbyBook.id, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

libbyBooks.delete("/bookmarks/:bookmarkId", async (req, res, next) => {
  try {
    await store.deleteBookmark(req.user.id, req.libbyBook.id, req.params.bookmarkId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

libbyBooks.post("/highlights", async (req, res, next) => {
  try {
    res.status(201).json({ highlight: await store.addHighlight(req.user.id, req.libbyBook.id, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

libbyBooks.delete("/highlights/:highlightId", async (req, res, next) => {
  try {
    await store.deleteHighlight(req.user.id, req.libbyBook.id, req.params.highlightId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

libbyBooks.get("/reviews", (_req, res) => {
  res.json({ myReview: null, reviews: [] });
});

libbyBooks.use((_req, res) => {
  res.status(404).json({ error: "Not available for Libby loans" });
});

app.use("/api/books/:bookId", (req, res, next) => {
  if (parseLibbyBookId(req.params.bookId)) {
    libbyBooks(req, res, next);
    return;
  }
  next();
});

app.use("/api/books/:bookId", (req, res, next) => {
  if (req.params.bookId === "upload") {
    next();
    return;
  }
  const book = store.getBook(req.params.bookId);
  if (!book || !platform.canAccessBook(req.user.id, book.id)) {
    res.status(404).json({ error: "Book not found" });
    return;
  }
  next();
});

app.get("/api/server", (req, res) => {
  const membership = platform.getMembership(serverIdentity.serverId, req.user.id);
  res.json({
    serverId: serverIdentity.serverId,
    name: serverName,
    role: membership?.role || "member",
    storage: {
      engine: storageInfo.engine,
      schemaVersion: storageInfo.schemaVersion
    },
    capabilities: ["ebooks", "audiobooks", "offline", "progress", "multi-user", "libraries", "invitations", "connection-tickets", "server-scoped-sync"]
  });
});

app.post("/api/mobile/web-session", (req, res) => {
  auth.issueSession(req, res, req.user);
  res.status(204).end();
});

app.put("/api/me/password", async (req, res, next) => {
  try {
    if (!auth.enabled) {
      res.status(400).json({ error: "Password changes require authentication" });
      return;
    }

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const user = store.getUser(req.user.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!currentPassword || newPassword.length < 8) {
      res.status(400).json({ error: "Current password and a new password of at least 8 characters are required" });
      return;
    }

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const updated = await store.setUserPassword(user.id, await hashPassword(newPassword));
    res.json({ user: updated });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", requireAdmin, (_req, res) => {
  res.json({ users: store.listUsers() });
});

app.post("/api/users", requireAdmin, async (req, res, next) => {
  try {
    const user = await store.createUser({
      username: req.body?.username,
      displayName: req.body?.displayName,
      role: req.body?.role,
      passwordHash: await hashPassword(String(req.body?.password || ""))
    });
    platform.ensureAccount(user, req.body?.email);
    await platform.upsertMembership({
      serverId: serverIdentity.serverId,
      accountId: user.id,
      localUserId: user.id,
      role: user.role === "admin" ? "admin" : "member"
    });
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/:userId", requireAdmin, async (req, res, next) => {
  try {
    const user = await store.updateUser(req.params.userId, req.body || {});
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.put("/api/users/:userId/password", requireAdmin, async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    const user = await store.setUserPassword(req.params.userId, await hashPassword(password));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/users/:userId", requireAdmin, async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }

    const users = store.listUsers();
    const target = users.find((user) => user.id === req.params.userId);
    const adminCount = users.filter((user) => user.role === "admin").length;
    if (target?.role === "admin" && adminCount <= 1) {
      res.status(400).json({ error: "At least one admin account is required" });
      return;
    }

    const deleted = await store.deleteUser(req.params.userId);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    activityTracker.remove(req.params.userId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/activity", requireAdmin, (req, res) => {
  const activity = activityTracker.list().flatMap((session) => {
    const user = store.getPublicUser(session.userId) ||
      (session.userId === req.user.id ? req.user : null);
    const book = store.getBook(session.bookId);
    if (!user || !book) {
      activityTracker.remove(session.userId);
      return [];
    }

    return [{
      user,
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        mediaType: book.mediaType || "ebook",
        coverUrl: book.coverPath
          ? `/api/books/${book.id}/cover?v=${encodeURIComponent(book.updatedAt)}`
          : null
      },
      percent: session.percent,
      startedAt: new Date(session.startedAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString()
    }];
  });

  res.json({ activity });
});

app.put("/api/activity", (req, res) => {
  const bookId = String(req.body?.bookId || "");
  const book = store.getBook(bookId);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }

  activityTracker.update(req.user.id, book.id, req.body?.percent);
  res.status(204).end();
});

app.delete("/api/activity", (req, res) => {
  activityTracker.remove(req.user.id);
  res.status(204).end();
});

app.get("/api/profile", (req, res) => {
  res.json(buildUserProfile(req.user.id));
});

app.post("/api/profile/usage", async (req, res, next) => {
  try {
    const mediaType = req.body?.mediaType === "audiobook" ? "audiobook" : "ebook";
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      res.status(400).json({ error: "A positive usage duration is required" });
      return;
    }
    const usage = await store.recordProfileUsage(req.user.id, mediaType, seconds);
    res.json({ usage });
  } catch (error) {
    next(error);
  }
});

app.put("/api/profile/read-list/:bookId", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    await store.addToReadList(req.user.id, book.id);
    res.json(buildUserProfile(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/profile/read-list/:bookId", async (req, res, next) => {
  try {
    await store.removeFromReadList(req.user.id, req.params.bookId);
    res.json(buildUserProfile(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/books", (req, res) => {
  const allowedLibraryIds = new Set(platform.listLibraries(req.user.id).map((library) => library.id));
  const requestedLibraryId = String(req.query.libraryId || "");
  res.json({
    books: store.listBooks()
      .filter((book) => {
        const libraryIds = platform.getBookLibraryIds(book.id);
        return libraryIds.some((libraryId) => allowedLibraryIds.has(libraryId)) &&
          (!requestedLibraryId || libraryIds.includes(requestedLibraryId));
      })
      .map((book) => decoratePlatformBook(book, req.user.id))
  });
});

app.get("/api/kindle/settings", (req, res) => {
  res.json({ settings: kindleDeliverySettings(store, req.user.id) });
});

app.post("/api/books/:bookId/send-to-kindle", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    const result = await sendBookToKindle({
      store,
      userId: req.user.id,
      book,
      kindleEmail: req.body?.kindleEmail
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/scan", async (req, res, next) => {
  try {
    const books = await scanLibrary(store, paths);
    await platform.reconcileBooks(books);
    res.json({ books: books.map((book) => decoratePlatformBook(book, req.user.id)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/books/upload", requireAdmin, upload.array("books", 50), async (req, res, next) => {
  try {
    const invalid = (req.files || []).filter((file) => {
      const ext = path.extname(file.originalname).toLowerCase();
      return !ALL_BOOK_EXTENSIONS.has(ext);
    });

    if (invalid.length > 0) {
      for (const file of invalid) {
        fsSync.rmSync(file.path, { force: true });
      }
    }

    const validFiles = (req.files || []).filter((file) => !invalid.includes(file));
    const deduplicated = await filterDuplicateUploads(validFiles);
    const uploadedAudioPaths = deduplicated.files
      .filter((file) => AUDIO_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
      .map((file) => normalizeUploadPath(path.relative(paths.libraryDir, file.path)));
    const books = await scanLibrary(store, paths, {
      audioBatchKey: uploadedAudioPaths.length > 1 ? crypto.randomUUID() : null,
      audioBatchPaths: uploadedAudioPaths
    });
    await platform.reconcileBooks(books);
    res.json({
      rejected: invalid.map((file) => file.originalname),
      duplicates: deduplicated.duplicates,
      books: books.map((book) => decoratePlatformBook(book, req.user.id))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/books/:bookId", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book || !platform.canAccessBook(req.user.id, book.id)) {
    res.status(404).json({ error: "Book not found" });
    return;
  }
  res.json({ book: decoratePlatformBook(book, req.user.id) });
});

app.patch("/api/books/:bookId", requireAdmin, async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    const title = metadataText(req.body?.title, 240);
    const pageCount = req.body?.pageCount === null || req.body?.pageCount === ""
      ? null
      : Number(req.body?.pageCount);
    if (!title) {
      res.status(400).json({ error: "Title is required" });
      return;
    }
    if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000)) {
      res.status(400).json({ error: "Page count must be a whole number between 1 and 100000" });
      return;
    }

    const updated = await store.updateBookMetadata(book.id, {
      title,
      subtitle: metadataText(req.body?.subtitle, 240) || null,
      series: metadataText(req.body?.series, 240) || null,
      author: metadataText(req.body?.author, 180) || "Unknown author",
      sortTitle: metadataText(req.body?.sortTitle, 240) || null,
      publisher: metadataText(req.body?.publisher, 180) || null,
      publicationDate: metadataText(req.body?.publicationDate, 40) || null,
      language: metadataText(req.body?.language, 80) || null,
      isbnAsin: metadataText(req.body?.isbnAsin, 80) || null,
      description: metadataText(req.body?.description, 5000) || null,
      pageCount,
      categories: metadataList(req.body?.categories, 50, 120),
      contributors: metadataList(req.body?.contributors, 50, 180),
      narrator: book.mediaType === "audiobook" ? metadataText(req.body?.narrator, 180) || null : null
    });
    res.json({ book: decoratePlatformBook(updated, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/books/:bookId", requireAdmin, async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    await deleteManagedBookFiles(book);
    await store.deleteBook(book.id);
    await platform.reconcileBooks(store.listBooks());
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/books/:bookId/reader", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }

  const readingFile = getReadingFile(book);
  const audioTracks = getAudioTracks(book);
  res.json({
    book: decoratePlatformBook(book, req.user.id),
    fileUrl: readingFile ? `/api/books/${book.id}/file?v=${encodeURIComponent(book.updatedAt)}` : null,
    format: readingFile?.format || null,
    audioTracks: audioTracks.map((track) => ({
      ...track,
      fileUrl: `/api/books/${book.id}/audio/${track.index}?v=${encodeURIComponent(book.updatedAt)}`
    })),
    progress: store.getProgress(req.user.id, book.id),
    bookmarks: store.listBookmarks(req.user.id, book.id),
    highlights: store.listHighlights(req.user.id, book.id),
    preferences: store.getPreferences(req.user.id),
    myReview: store.getReview(req.user.id, book.id),
    reviews: store.listBookReviews(book.id)
  });
});

app.get("/api/books/:bookId/file", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }

  const readingFile = getReadingFile(book);
  if (!readingFile) {
    res.status(409).json({ error: "Book needs conversion before reading" });
    return;
  }

  streamFile(
    req,
    res,
    readingFile.filePath,
    readingFile.format === "epub"
      ? "application/epub+zip"
      : readingFile.format === "pdf"
        ? "application/pdf"
        : "audio/mpeg"
  );
});

app.get("/api/books/:bookId/audio/:trackIndex", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book || book.readingFormat !== "audio") {
    res.status(404).json({ error: "Audiobook not found" });
    return;
  }

  const trackIndex = Number.parseInt(req.params.trackIndex, 10);
  const track = Number.isInteger(trackIndex) ? book.audioFiles?.[trackIndex] : null;
  if (!track) {
    res.status(404).json({ error: "Audio track not found" });
    return;
  }

  streamFile(req, res, track.path, "audio/mpeg");
});

app.get("/api/cast/config", (_req, res) => {
  res.json({ receiverAppId: castReceiverAppId });
});

app.post("/api/books/:bookId/cast", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book || book.readingFormat !== "audio") {
    res.status(404).json({ error: "Audiobook not found" });
    return;
  }
  const { token, expiresAt } = castLinks.issue(req.user.id, book.id);
  // The Chromecast needs absolute https links; PUBLIC_URL is the address it can reach.
  const origin = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;
  const base = `${origin}/cast/${token}`;
  res.json({
    expiresAt,
    receiverAppId: castReceiverAppId,
    title: book.title,
    author: book.author || null,
    coverUrl: book.coverPath ? `${base}/cover` : null,
    progressUrl: `${base}/progress`,
    tracks: getAudioTracks(book).map((track) => ({
      ...track,
      url: `${base}/audio/${track.index}`,
      contentType: castContentType(book.audioFiles[track.index].path)
    }))
  });
});

function castContentType(filePath) {
  return mime.lookup(filePath) || "audio/mpeg";
}

app.get("/api/books/:bookId/cover", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book || !book.coverPath) {
    res.status(404).json({ error: "Cover not found" });
    return;
  }

  streamFile(req, res, book.coverPath, book.coverMime || "image/jpeg");
});

app.put("/api/books/:bookId/cover", requireAdmin, coverUpload.single("cover"), async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "Cover image is required" });
      return;
    }

    const extension = coverMimeExtensions.get(req.file.mimetype);
    if (!extension) {
      res.status(415).json({ error: "Cover art must be a JPEG, PNG, or WebP image" });
      return;
    }

    const coverPath = path.join(paths.coverDir, `${book.id}-manual-cover${extension}`);
    await fs.writeFile(coverPath, req.file.buffer);
    const updated = await store.patchBook(book.id, {
      coverPath,
      coverMime: req.file.mimetype
    });

    if (book.coverPath && path.resolve(book.coverPath) !== path.resolve(coverPath) && isPathInside(book.coverPath, paths.coverDir)) {
      await fs.rm(book.coverPath, { force: true }).catch(() => {});
    }

    res.json({ book: decoratePlatformBook(updated, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/books/:bookId/artwork", requireAdmin, async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    const title = metadataText(req.query?.title, 240) || book.title;
    const author = metadataText(req.query?.author, 180) || book.author;
    const artwork = await searchOpenLibraryArtwork({ title, author });
    res.json({ artwork, query: { title, author } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/books/:bookId/artwork", requireAdmin, async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    const artwork = await downloadOpenLibraryCover(req.body?.coverId);
    const coverPath = path.join(paths.coverDir, `${book.id}-manual-cover${artwork.extension}`);
    await fs.writeFile(coverPath, artwork.buffer);
    const updated = await store.patchBook(book.id, {
      coverPath,
      coverMime: artwork.mime
    });

    if (book.coverPath && path.resolve(book.coverPath) !== path.resolve(coverPath) && isPathInside(book.coverPath, paths.coverDir)) {
      await fs.rm(book.coverPath, { force: true }).catch(() => {});
    }

    res.json({ book: decoratePlatformBook(updated, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/books/:bookId/convert", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }

    if (getReadingFile(book)) {
      res.json({ book: decoratePlatformBook(book, req.user.id) });
      return;
    }

    if (!book.canConvert) {
      res.status(415).json({ error: "This file type is not supported" });
      return;
    }

    if (!conversionJobs.has(book.id)) {
      const job = convertBook(store, paths, book.id)
        .catch(() => null)
        .finally(() => conversionJobs.delete(book.id));
      conversionJobs.set(book.id, job);
    }

    const updated = await store.patchBook(book.id, { status: "converting", error: null });
    res.status(202).json({ book: decoratePlatformBook(updated, req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/books/:bookId/progress", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    const progress = await store.setProgress(req.user.id, book.id, req.body || {});
    res.json({ progress });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mobile/playback-progress", async (req, res, next) => {
  try {
    const [bookId, trackValue] = String(req.body?.mediaId || "").split(":");
    const book = store.getBook(bookId);
    const update = book ? audioProgressUpdate(book, trackValue, req.body?.position, req.body?.duration) : null;
    if (!update) {
      res.status(400).json({ error: "Invalid audiobook progress update" });
      return;
    }
    const progress = await store.setProgress(req.user.id, book.id, update);
    res.json({ progress });
  } catch (error) {
    next(error);
  }
});

// Turns a position within one track into whole-book progress, as the web player stores it.
function audioProgressUpdate(book, trackValue, positionValue, durationValue) {
  const trackIndex = Number.parseInt(trackValue, 10);
  if (book.readingFormat !== "audio" || !Number.isInteger(trackIndex) || !book.audioFiles?.[trackIndex]) {
    return null;
  }
  const position = Math.max(0, Number(positionValue) || 0);
  const reportedDuration = Math.max(0, Number(durationValue) || 0);
  const trackDuration = Number(book.audioFiles[trackIndex].durationSeconds) || reportedDuration;
  const elapsedBeforeTrack = book.audioFiles
    .slice(0, trackIndex)
    .reduce((sum, track) => sum + (Number(track.durationSeconds) || 0), 0);
  const totalDuration =
    Number(book.durationSeconds) ||
    book.audioFiles.reduce((sum, track) => sum + (Number(track.durationSeconds) || 0), 0);
  const currentTime = elapsedBeforeTrack + Math.min(position, trackDuration || position);
  return {
    percent: totalDuration > 0 ? currentTime / totalDuration : 0,
    currentTime,
    duration: totalDuration || null,
    trackIndex,
    trackTime: position
  };
}

app.post("/api/books/:bookId/bookmarks", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    const bookmark = await store.addBookmark(req.user.id, book.id, req.body || {});
    res.status(201).json({ bookmark });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/books/:bookId/bookmarks/:bookmarkId", async (req, res, next) => {
  try {
    await store.deleteBookmark(req.user.id, req.params.bookId, req.params.bookmarkId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/books/:bookId/highlights", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    const highlight = await store.addHighlight(req.user.id, book.id, req.body || {});
    res.status(201).json({ highlight });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/books/:bookId/highlights/:highlightId", async (req, res, next) => {
  try {
    await store.deleteHighlight(req.user.id, req.params.bookId, req.params.highlightId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/books/:bookId/reviews", (req, res) => {
  const book = store.getBook(req.params.bookId);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }
  res.json({
    myReview: store.getReview(req.user.id, book.id),
    reviews: store.listBookReviews(book.id)
  });
});

app.put("/api/books/:bookId/review", async (req, res, next) => {
  try {
    const book = store.getBook(req.params.bookId);
    if (!book) {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    const review = await store.upsertReview(req.user.id, book.id, req.body || {});
    res.json({
      review,
      reviews: store.listBookReviews(book.id)
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/books/:bookId/review", async (req, res, next) => {
  try {
    await store.deleteReview(req.user.id, req.params.bookId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/preferences", (req, res) => {
  res.json({ preferences: store.getPreferences(req.user.id) });
});

app.put("/api/preferences", async (req, res, next) => {
  try {
    const preferences = await store.setPreferences(req.user.id, req.body || {});
    res.json({ preferences });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dictionary", async (req, res, next) => {
  try {
    const result = await lookupDefinition(store, req.query.word);
    if (!result) {
      res.status(400).json({ error: "Word is required" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

if (fsSync.existsSync(distDir)) {
  // index.html and sw.js must revalidate so a deploy reaches open browsers; hashed assets can cache.
  const revalidate = (res) => res.setHeader("Cache-Control", "no-cache");
  app.use(express.static(distDir, {
    setHeaders: (res, filePath) => {
      if (/\.html$|[\\/]sw\.js$/.test(filePath)) revalidate(res);
    }
  }));
  app.get(/.*/, (_req, res) => {
    revalidate(res);
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const requestedStatus = Number(error?.status);
  const status = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
    ? 413
    : Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
      ? requestedStatus
      : 500;
  res.status(status).json({
    error: error?.message || "Internal server error"
  });
});

function decoratePlatformBook(book, userId) {
  return {
    ...decorateBook(store, book, userId),
    serverId: serverIdentity.serverId,
    libraryIds: platform.getBookLibraryIds(book.id)
  };
}

function buildUserProfile(userId) {
  const user = store.getPublicUser(userId);
  const usage = store.getProfileUsage(userId);
  const history = store.listUserProgress(userId)
    .flatMap(({ bookId, progress }) => {
      const book = store.getBook(bookId);
      if (book && !platform.canAccessBook(userId, book.id)) return [];
      if (!book || Number(progress?.percent || 0) <= 0) {
        return [];
      }
      return [{ book: decoratePlatformBook(book, userId), progress }];
    })
    .sort((a, b) => dateValue(b.progress.updatedAt) - dateValue(a.progress.updatedAt));
  const reviews = store.listUserReviews(userId)
    .flatMap(({ bookId, review }) => {
      const book = store.getBook(bookId);
      if (book && !platform.canAccessBook(userId, book.id)) return [];
      return book ? [{ book: decoratePlatformBook(book, userId), review }] : [];
    })
    .sort((a, b) => dateValue(b.review.updatedAt) - dateValue(a.review.updatedAt));
  const marks = store.listUserHighlights(userId)
    .flatMap(({ bookId, highlight }) => {
      const book = store.getBook(bookId);
      if (book && !platform.canAccessBook(userId, book.id)) return [];
      return book ? [{ book: decoratePlatformBook(book, userId), highlight }] : [];
    })
    .sort((a, b) => dateValue(b.highlight.createdAt) - dateValue(a.highlight.createdAt));
  const readList = store.listReadList(userId)
    .flatMap(({ bookId, addedAt }) => {
      const book = store.getBook(bookId);
      if (book && !platform.canAccessBook(userId, book.id)) return [];
      return book ? [{ book: decoratePlatformBook(book, userId), addedAt }] : [];
    });
  const completed = history.filter(({ progress }) => Number(progress?.percent || 0) >= 0.995);

  return {
    user,
    stats: {
      booksRead: completed.filter(({ book }) => book.mediaType === "ebook").length,
      audiobooksListened: completed.filter(({ book }) => book.mediaType === "audiobook").length,
      readingSeconds: usage.readingSeconds,
      listeningSeconds: usage.listeningSeconds
    },
    history,
    reviews,
    marks,
    readList
  };
}

function dateValue(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const port = Number(process.env.PORT || 3000);
const httpServer = app.listen(port, "0.0.0.0", () => {
  console.log(`Shelf listening on http://0.0.0.0:${port}`);
  console.log(`Library: ${paths.libraryDir}`);
  console.log(`Data: ${paths.dataDir}`);
  console.log(`Server ID: ${serverIdentity.serverId}`);
  console.log(`Storage: SQLite schema ${storageInfo.schemaVersion}`);
  void runInitialLibraryScan();
});

async function runInitialLibraryScan() {
  initialLibraryScanStatus = "running";
  try {
    const books = await scanLibrary(store, paths);
    await platform.reconcileBooks(books);
    initialLibraryScanStatus = "ready";
    console.log(`Library scan complete: ${books.length} titles`);
  } catch (error) {
    initialLibraryScanStatus = "error";
    console.error("Initial library scan failed", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    const forcedExit = setTimeout(() => process.exit(1), 10_000);
    forcedExit.unref();
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

function uniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;

  while (fsSync.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

function normalizeUploadPath(value) {
  return value.split(path.sep).join("/");
}

function metadataText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function metadataList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .map((item) => metadataText(item, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

async function deleteManagedBookFiles(book) {
  const allowedRoots = [paths.libraryDir, paths.dataDir];
  const candidates = [
    book.path,
    book.convertedPath,
    book.coverPath,
    ...(book.audioFiles || []).map((track) => track.path)
  ].filter(Boolean);
  const seen = new Set();

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);

    if (!allowedRoots.some((root) => isPathInside(resolved, root))) {
      throw new Error("Refusing to delete a file outside the library storage directories");
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      continue;
    }
    if (!stat.isFile()) {
      throw new Error("Refusing to delete a non-file library path");
    }
    await fs.rm(resolved, { force: true });
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function registrationAttemptEvent(req, body) {
  return {
    status: "received",
    reason: "",
    username: normalizeUsername(body?.username),
    displayName: String(body?.displayName || "").trim().slice(0, 80),
    ip: getClientIp(req),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 240),
    at: new Date().toISOString()
  };
}

function checkRegistrationRateLimit(req) {
  const key = getClientIp(req) || "unknown";
  const now = Date.now();
  const cutoff = now - registrationWindowMs;
  const attempts = (registrationAttempts.get(key) || []).filter((time) => time > cutoff);
  if (attempts.length >= registrationMaxAttempts) {
    registrationAttempts.set(key, attempts);
    return { allowed: false };
  }

  attempts.push(now);
  registrationAttempts.set(key, attempts);
  return { allowed: true };
}

function getRegistrationDisabledReason(registrationNotificationsReady) {
  if (!auth.enabled) {
    return null;
  }
  if (!registrationEnabled) {
    return "Registration is turned off.";
  }
  if (!registrationNotificationsReady) {
    return "Registration needs email notification settings before new accounts can be created.";
  }
  return null;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "";
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
