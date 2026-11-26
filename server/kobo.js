import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { getReadingFile, streamFile } from "./library.js";

/*
 * Kobo sync: shelf answers the Kobo's store API for the books a reader chose to send,
 * the same way Calibre-Web and Komga do. The Kobo's api_endpoint points at
 * /kobo/<token>; everything shelf doesn't handle itself is passed on to the real Kobo store
 * so the device's own store, account and purchases keep working.
 */

export const KOBO_STORE_URL = "https://storeapi.kobo.com";
const KOBO_IMAGE_HOST = "https://cdn.kobo.com/book-images";
const SYNC_TOKEN_PREFIX = "shelf1.";
const SYNC_PAGE_SIZE = 100;
const STORE_TIMEOUT_MS = 15000;
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer"
]);

// The book's ID as the Kobo sees it: a UUID derived from the shelf ID, stable across syncs.
export function koboBookId(bookId) {
  const hash = crypto.createHash("sha1").update(`shelf-kobo:${bookId}`).digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Kobo sync covers EPUBs, including books shelf converted to EPUB.
export function isKoboCompatible(book) {
  if (!book || book.mediaType === "audiobook" || book.readingFormat === "audio") {
    return false;
  }
  return getReadingFile(book)?.format === "epub";
}

export function koboTimestamp(value) {
  const time = value ? Date.parse(value) : Date.now();
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function encodeSyncToken(state) {
  return SYNC_TOKEN_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}

// A token shelf didn't issue is the Kobo store's own token from before shelf was set up; keep it for the store.
export function decodeSyncToken(header) {
  const value = String(header || "").trim();
  if (value.startsWith(SYNC_TOKEN_PREFIX)) {
    try {
      const parsed = JSON.parse(Buffer.from(value.slice(SYNC_TOKEN_PREFIX.length), "base64url").toString("utf8"));
      return {
        since: typeof parsed.since === "string" ? parsed.since : null,
        storeToken: typeof parsed.storeToken === "string" ? parsed.storeToken : null
      };
    } catch {
      return { since: null, storeToken: null };
    }
  }
  return { since: null, storeToken: value || null };
}

// Reads the EPUB's spine, in the same order the web reader pages through it.
const spineCache = new Map();
export async function readEpubSpine(filePath) {
  const stat = await fs.stat(filePath);
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  if (spineCache.has(key)) {
    return spineCache.get(key);
  }
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container || "")?.[1];
  const opf = opfPath ? await zip.file(decodeURIComponent(opfPath))?.async("string") || await zip.file(opfPath)?.async("string") : null;
  const spine = [];
  if (opf) {
    const base = path.posix.dirname(opfPath);
    const manifest = new Map();
    for (const match of opf.matchAll(/<(?:\w+:)?item\b([^>]*)>/gi)) {
      const id = xmlAttribute(match[1], "id");
      const href = xmlAttribute(match[1], "href");
      if (id && href) {
        manifest.set(id, { href: resolveZipPath(base, href), mediaType: xmlAttribute(match[1], "media-type") || "" });
      }
    }
    for (const match of opf.matchAll(/<(?:\w+:)?itemref\b([^>]*)>/gi)) {
      const item = manifest.get(xmlAttribute(match[1], "idref") || "");
      if (item && /xhtml|html/i.test(item.mediaType || item.href)) {
        spine.push(item.href);
      }
    }
  }
  spineCache.set(key, spine);
  if (spineCache.size > 200) {
    spineCache.delete(spineCache.keys().next().value);
  }
  return spine;
}

function xmlAttribute(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attributes);
  return match ? decodeXmlEntities(match[2] ?? match[3] ?? "") : null;
}

function decodeXmlEntities(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function resolveZipPath(base, href) {
  const clean = href.split("#")[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the href as written.
  }
  return path.posix.normalize(base && base !== "." ? `${base}/${decoded}` : decoded).replace(/^\/+/, "");
}

// Finds which spine section a Kobo bookmark points at; Kobo names it by its path inside the EPUB.
export function spineIndexForSource(spine, source) {
  if (!source || spine.length === 0) {
    return -1;
  }
  let target = String(source).split("#")[0].replace(/\\/g, "/").replace(/^\/+/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the source as sent.
  }
  const lower = target.toLowerCase();
  let index = spine.findIndex((href) => href.toLowerCase() === lower);
  if (index < 0) {
    index = spine.findIndex((href) => href.toLowerCase().endsWith(`/${lower}`) || lower.endsWith(`/${href.toLowerCase()}`));
  }
  if (index < 0) {
    const name = path.posix.basename(lower);
    const matches = spine.filter((href) => path.posix.basename(href.toLowerCase()) === name);
    index = matches.length === 1 ? spine.indexOf(matches[0]) : -1;
  }
  return index;
}

// Turns the Kobo's bookmark into shelf progress the web reader can open at.
export function progressFromKoboBookmark(bookmark, status, spine) {
  const percent = clamp01(Number(bookmark?.ProgressPercent) / 100);
  const finished = status === "Finished";
  const sectionCount = spine.length;
  let locator = null;
  if (sectionCount > 0) {
    const index = spineIndexForSource(spine, bookmark?.Location?.Source);
    const chapterPercent = Number(bookmark?.ContentSourceProgressPercent);
    if (index >= 0) {
      const fraction = Number.isFinite(chapterPercent) ? clamp01(chapterPercent / 100) : 0;
      locator = epubFractionLocator(index, fraction);
    } else if (Number.isFinite(percent)) {
      const position = Math.min(sectionCount - 0.0001, percent * sectionCount);
      locator = epubFractionLocator(Math.floor(position), position - Math.floor(position));
    }
  }
  return {
    percent: finished ? 1 : Number.isFinite(percent) ? percent : 0,
    locator
  };
}

function epubFractionLocator(sectionIndex, fraction) {
  return `section:${sectionIndex}:fraction:${Math.round(clamp01(fraction) * 10000) / 10000}`;
}

// Shelf progress, as a Kobo bookmark. Kepubs can jump to the section; plain EPUBs get the percentage.
export function koboBookmarkFromProgress(progress, spine, format) {
  const percent = clamp01(Number(progress?.percent) || 0);
  const bookmark = {
    LastModified: koboTimestamp(progress?.updatedAt),
    ProgressPercent: Math.round(percent * 1000) / 10
  };
  const match = /^section:(\d+)(?::(?:page|fraction):([\d.]+))?/.exec(progress?.locator || "");
  if (format === "KEPUB" && spine.length > 0 && percent > 0) {
    const sectionIndex = match
      ? Math.min(spine.length - 1, Number(match[1]))
      : Math.min(spine.length - 1, Math.floor(percent * spine.length));
    const withinSection = clamp01(percent * spine.length - sectionIndex);
    bookmark.ContentSourceProgressPercent = Math.round(withinSection * 1000) / 10;
    bookmark.Location = { Value: "kobo.1.1", Type: "KoboSpan", Source: spine[sectionIndex] };
  }
  return bookmark;
}

/*
 * Whether shelf has progress the Kobo doesn't. Opening a book in shelf saves its own idea of the
 * same spot, so only a move to another section (or 2% further when sections are unknown) counts.
 */
export function shelfMovedPastKobo(progress, koboState, spine = []) {
  if (!progress?.updatedAt) return false;
  if (!koboState?.CurrentBookmark) return true;
  if (progress.updatedAt === koboState.shelfProgressUpdatedAt) return false;
  const shelfPercent = Number(progress.percent) || 0;
  const koboPercent = (Number(koboState.CurrentBookmark.ProgressPercent) || 0) / 100;
  if ((shelfPercent >= 0.995) !== (koboState.StatusInfo?.Status === "Finished" || koboPercent >= 0.995)) return true;
  const shelfSection = /^section:(\d+)/.exec(progress.locator || "")?.[1];
  const koboSection = spineIndexForSource(spine, koboState.CurrentBookmark.Location?.Source);
  if (shelfSection !== undefined && koboSection >= 0) {
    return Number(shelfSection) !== koboSection;
  }
  return Math.abs(shelfPercent - koboPercent) > 0.02;
}

export function koboStatus(percent, koboState) {
  if (percent >= 0.995) return "Finished";
  if (percent > 0) return "Reading";
  return koboState?.StatusInfo?.Status === "Finished" ? "Finished" : "ReadyToRead";
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NaN;
}

/**
 * Kepubify (github.com/pgaskin/kepubify) turns an EPUB into a Kobo kepub, which gives the Kobo
 * its fast renderer, reading stats and exact positions. Without it the Kobo gets the plain EPUB.
 */
export function createKepubConverter(dataDir, { binary = process.env.KEPUBIFY_PATH || "kepubify" } = {}) {
  const cacheDir = path.join(dataDir, "kobo-kepub");
  const running = new Map();
  let available = null;

  async function isAvailable() {
    if (available === null) {
      available = await new Promise((resolve) => {
        execFile(binary, ["--version"], { timeout: 10000 }, (error) => resolve(!error));
      });
    }
    return available;
  }

  async function cachedPath(book, sourcePath) {
    const stat = await fs.stat(sourcePath);
    const key = crypto.createHash("sha1").update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`).digest("hex").slice(0, 12);
    return path.join(cacheDir, `${book.id}-${key}.kepub.epub`);
  }

  async function convert(book, sourcePath) {
    const output = await cachedPath(book, sourcePath);
    if (fsSync.existsSync(output)) {
      return output;
    }
    if (running.has(output)) {
      return running.get(output);
    }
    const job = (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      // Older copies of this book are stale once the file changes.
      for (const name of await fs.readdir(cacheDir)) {
        if (name.startsWith(`${book.id}-`)) await fs.rm(path.join(cacheDir, name), { force: true });
      }
      // kepubify treats an output path that doesn't exist yet as the file name to write.
      const temporary = output.replace(/\.kepub\.epub$/, `.tmp-${process.pid}.kepub.epub`);
      await fs.rm(temporary, { force: true });
      await new Promise((resolve, reject) => {
        execFile(binary, ["--output", temporary, sourcePath], { timeout: 5 * 60 * 1000 }, (error, _stdout, stderr) => {
          if (error) reject(new Error(`kepubify failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
          else resolve();
        });
      });
      await fs.rename(temporary, output);
      return output;
    })().finally(() => running.delete(output));
    running.set(output, job);
    return job;
  }

  return {
    isAvailable,
    async fileFor(book, { convertIfMissing = true } = {}) {
      const reading = getReadingFile(book);
      if (!reading || reading.format !== "epub") {
        return null;
      }
      const sourcePath = reading.filePath;
      if (/\.kepub\.epub$/i.test(sourcePath)) {
        return { path: sourcePath, format: "KEPUB", sourcePath };
      }
      if (await isAvailable()) {
        try {
          const output = await cachedPath(book, sourcePath);
          if (fsSync.existsSync(output)) {
            return { path: output, format: "KEPUB", sourcePath };
          }
          if (convertIfMissing) {
            return { path: await convert(book, sourcePath), format: "KEPUB", sourcePath };
          }
        } catch (error) {
          console.warn(`Kobo: serving the plain EPUB for ${book.id} because ${error.message}`);
        }
      }
      return { path: sourcePath, format: "EPUB", sourcePath };
    }
  };
}

/**
 * Builds the /kobo/:token router.
 * resolveUser(userId) returns the user or null; canAccessBook(userId, bookId) applies server and library access.
 */
export function createKoboRouter({ store, resolveUser, canAccessBook, kepub, publicUrl = "", storeUrl, storeProxy = true, fetchImpl = fetch }) {
  const router = express.Router({ mergeParams: true });
  const koboStore = String(storeUrl || KOBO_STORE_URL).replace(/\/+$/, "");

  router.use(express.raw({ type: () => true, limit: "8mb" }));

  router.use((req, res, next) => {
    const record = store.findKoboToken(req.params.token);
    const user = record ? resolveUser(record.userId) : null;
    if (!user) {
      res.status(401).json({ error: "This Kobo sync link is not valid. Make a new one in shelf." });
      return;
    }
    req.koboUser = user;
    req.koboBase = `${requestOrigin(req, publicUrl)}/kobo/${req.params.token}`;
    if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60 * 1000) {
      void store.touchKoboToken(record.id).catch(() => undefined);
    }
    next();
  });

  function userBooks(userId, { includeRemoved = false } = {}) {
    const entries = [];
    for (const row of store.listKoboBooks(userId, { includeRemoved })) {
      const book = store.getBook(row.bookId);
      const usable = book && isKoboCompatible(book) && canAccessBook(userId, book.id);
      if (!usable && !row.removedAt && !includeRemoved) continue;
      entries.push({ row, book: usable ? book : null, koboId: koboBookId(row.bookId) });
    }
    return entries;
  }

  function findEntry(req, koboId) {
    return userBooks(req.koboUser.id, { includeRemoved: true }).find((entry) => entry.koboId === koboId) || null;
  }

  async function bookMetadata(req, entry, file) {
    const { book, koboId } = entry;
    const stat = file ? await fs.stat(file.path).catch(() => null) : null;
    const downloadUrl = `${req.koboBase}/download/${koboId}/${file?.format === "KEPUB" ? "kepub" : "epub"}`;
    const formats = file?.format === "KEPUB" ? ["KEPUB"] : ["EPUB3", "EPUB"];
    const metadata = {
      Categories: ["00000000-0000-0000-0000-000000000001"],
      CoverImageId: koboId,
      CrossRevisionId: koboId,
      CurrentDisplayPrice: { CurrencyCode: "USD", TotalAmount: 0 },
      CurrentLoveDisplayPrice: { TotalAmount: 0 },
      Description: book.description || null,
      DownloadUrls: formats.map((format) => ({
        Format: format,
        Size: stat?.size || book.size || 0,
        Url: downloadUrl,
        Platform: "Generic"
      })),
      EntitlementId: koboId,
      ExternalIds: [],
      Genre: "00000000-0000-0000-0000-000000000001",
      IsEligibleForKoboLove: false,
      IsInternetArchive: false,
      IsPreOrder: false,
      IsSocialEnabled: true,
      Language: String(book.language || "en").slice(0, 2).toLowerCase() || "en",
      PhoneticPronunciations: {},
      PublicationDate: book.publicationDate ? koboTimestamp(book.publicationDate) : null,
      Publisher: { Imprint: "", Name: book.publisher || null },
      RevisionId: koboId,
      Title: book.title || book.filename,
      WorkId: koboId,
      ContributorRoles: book.author ? [{ Name: book.author }] : [],
      Contributors: book.author ? [book.author] : []
    };
    if (book.subtitle) metadata.SubTitle = book.subtitle;
    const series = parseSeries(book.series);
    if (series) {
      metadata.Series = {
        Name: series.name,
        Number: series.number ?? 0,
        NumberFloat: series.number ?? 0,
        Id: crypto.createHash("sha1").update(`shelf-kobo-series:${series.name}`).digest("hex").slice(0, 32)
      };
    }
    return metadata;
  }

  function bookEntitlement(entry) {
    const { row, book, koboId } = entry;
    return {
      Accessibility: "Full",
      ActivePeriod: { From: koboTimestamp(row.addedAt) },
      Created: koboTimestamp(book?.addedAt || row.addedAt),
      CrossRevisionId: koboId,
      Id: koboId,
      IsHiddenFromArchive: false,
      IsLocked: false,
      IsRemoved: Boolean(row.removedAt) || !book,
      LastModified: koboTimestamp(latest(row.updatedAt, book?.updatedAt)),
      OriginCategory: "Imported",
      RevisionId: koboId,
      Status: "Active"
    };
  }

  async function readingState(userId, entry, file) {
    const { book, koboId } = entry;
    const progress = store.getProgress(userId, book.id);
    const koboState = store.getKoboReadingState(userId, book.id);
    const percent = Number(progress?.percent) || 0;
    const spine = file && percent > 0 ? await readEpubSpine(file.sourcePath).catch(() => []) : [];
    // The Kobo's own bookmark stands until shelf progress moves on from it.
    const fromKobo = koboState?.CurrentBookmark && !shelfMovedPastKobo(progress, koboState, spine);
    const modified = koboTimestamp(latest(progress?.updatedAt, koboState?.LastModified, entry.row.addedAt));
    const status = fromKobo ? koboState.StatusInfo?.Status || koboStatus(percent, koboState) : koboStatus(percent, koboState);
    return {
      EntitlementId: koboId,
      Created: koboTimestamp(entry.row.addedAt),
      LastModified: modified,
      PriorityTimestamp: modified,
      StatusInfo: {
        LastModified: modified,
        Status: status,
        TimesStartedReading: Math.max(Number(koboState?.StatusInfo?.TimesStartedReading) || 0, percent > 0 ? 1 : 0),
        ...(koboState?.StatusInfo?.LastTimeStartedReading ? { LastTimeStartedReading: koboState.StatusInfo.LastTimeStartedReading } : {})
      },
      Statistics: {
        LastModified: koboTimestamp(koboState?.Statistics?.LastModified || modified),
        ...(Number.isFinite(Number(koboState?.Statistics?.SpentReadingMinutes)) ? { SpentReadingMinutes: Number(koboState.Statistics.SpentReadingMinutes) } : {}),
        ...(Number.isFinite(Number(koboState?.Statistics?.RemainingTimeMinutes)) ? { RemainingTimeMinutes: Number(koboState.Statistics.RemainingTimeMinutes) } : {})
      },
      CurrentBookmark: fromKobo
        ? { ...koboState.CurrentBookmark, LastModified: koboTimestamp(koboState.CurrentBookmark.LastModified || modified) }
        : progress
          ? koboBookmarkFromProgress(progress, spine, file?.format)
          : { LastModified: modified }
    };
  }

  // The device's own requests, passed on to the real Kobo store.
  async function forwardToStore(req, { path: overridePath, headers: overrideHeaders = {} } = {}) {
    const target = `${koboStore}${overridePath ?? req.url}`;
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    for (const [name, value] of Object.entries(overrideHeaders)) {
      if (value === null) delete headers[name];
      else headers[name] = value;
    }
    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    return fetchImpl(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
    });
  }

  async function proxy(req, res, fallback) {
    if (!storeProxy) {
      fallback(res);
      return;
    }
    try {
      const response = await forwardToStore(req);
      res.status(response.status);
      response.headers.forEach((value, name) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) res.setHeader(name, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.warn(`Kobo: the Kobo store did not answer ${req.method} ${req.path}: ${error.message}`);
      fallback(res);
    }
  }

  const emptyObject = (res) => res.json({});

  router.get("/v1/initialization", async (req, res) => {
    let resources = null;
    if (storeProxy) {
      try {
        const response = await forwardToStore(req);
        if (response.ok) resources = (await response.json())?.Resources || null;
      } catch (error) {
        console.warn(`Kobo: using built-in store settings because the Kobo store did not answer: ${error.message}`);
      }
    }
    resources = { ...(resources || FALLBACK_RESOURCES) };
    // Store calls come back through shelf (which forwards what it doesn't answer); covers too.
    for (const [key, value] of Object.entries(resources)) {
      if (typeof value === "string" && value.startsWith(KOBO_STORE_URL)) {
        resources[key] = req.koboBase + value.slice(KOBO_STORE_URL.length);
      }
    }
    resources.image_host = requestOrigin(req, publicUrl);
    resources.image_url_template = `${req.koboBase}/{ImageId}/{Width}/{Height}/false/image.jpg`;
    resources.image_url_quality_template = `${req.koboBase}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`;
    res.setHeader("x-kobo-apitoken", "e30=");
    res.json({ Resources: resources });
  });

  router.post("/v1/auth/device", (req, res) =>
    proxy(req, res, (reply) => {
      let userKey = "";
      try {
        userKey = JSON.parse(bodyText(req) || "{}").UserKey || "";
      } catch {
        // No user key sent.
      }
      const token = crypto.randomBytes(24).toString("base64");
      reply.json({ AccessToken: token, RefreshToken: token, TokenType: "Bearer", TrackingId: crypto.randomUUID(), UserKey: userKey });
    })
  );

  router.get("/v1/library/sync", async (req, res, next) => {
    try {
      const token = decodeSyncToken(req.get("x-kobo-synctoken"));
      const userId = req.koboUser.id;
      const since = token.since ? Date.parse(token.since) : 0;
      const changes = [];

      for (const entry of userBooks(userId, { includeRemoved: true })) {
        const { row, book } = entry;
        const removed = Boolean(row.removedAt) || !book;
        const entitlementTime = Date.parse(latest(row.updatedAt, book?.updatedAt));
        if (removed) {
          // Only books this Kobo already had need removing.
          if (since && Date.parse(row.updatedAt) > since && Date.parse(row.addedAt) <= since) {
            changes.push({ time: Date.parse(row.updatedAt), entry, kind: "removed" });
          }
          continue;
        }
        if (!since || entitlementTime > since) {
          changes.push({ time: entitlementTime, entry, kind: !since || Date.parse(row.addedAt) > since ? "new" : "changed" });
          continue;
        }
        const progress = store.getProgress(userId, book.id);
        if (progress?.updatedAt && Date.parse(progress.updatedAt) > since) {
          const koboState = store.getKoboReadingState(userId, book.id);
          const file = koboState ? await kepub.fileFor(book, { convertIfMissing: false }) : null;
          const spine = file ? await readEpubSpine(file.sourcePath).catch(() => []) : [];
          if (shelfMovedPastKobo(progress, koboState, spine)) {
            changes.push({ time: Date.parse(progress.updatedAt), entry, kind: "state" });
          }
        }
      }

      changes.sort((a, b) => a.time - b.time);
      let page = changes.slice(0, SYNC_PAGE_SIZE);
      if (changes.length > SYNC_PAGE_SIZE) {
        // Keep changes that share the last timestamp on the same page so none is skipped.
        const boundary = page[page.length - 1].time;
        page = changes.filter((change) => change.time <= boundary);
      }
      const more = page.length < changes.length;

      const results = [];
      for (const change of page) {
        const { entry } = change;
        if (change.kind === "removed") {
          results.push({ ChangedEntitlement: { BookEntitlement: bookEntitlement(entry) } });
          continue;
        }
        const file = await kepub.fileFor(entry.book);
        if (change.kind === "state") {
          results.push({ ChangedReadingState: { ReadingState: await readingState(userId, entry, file) } });
          continue;
        }
        const payload = {
          BookEntitlement: bookEntitlement(entry),
          BookMetadata: await bookMetadata(req, entry, file),
          ReadingState: await readingState(userId, entry, file)
        };
        results.push(change.kind === "new" ? { NewEntitlement: payload } : { ChangedEntitlement: payload });
      }

      const nextSince = page.length ? new Date(page[page.length - 1].time).toISOString() : token.since;
      let storeToken = token.storeToken;
      let storeContinues = false;
      if (storeProxy && !more) {
        try {
          const response = await forwardToStore(req, { headers: { "x-kobo-synctoken": storeToken || null } });
          if (response.ok) {
            const storeResults = await response.json();
            if (Array.isArray(storeResults)) results.push(...storeResults);
            storeToken = response.headers.get("x-kobo-synctoken") || storeToken;
            storeContinues = response.headers.get("x-kobo-sync") === "continue";
            for (const name of ["x-kobo-sync-mode", "x-kobo-recent-reads"]) {
              const value = response.headers.get(name);
              if (value) res.setHeader(name, value);
            }
          } else {
            console.warn(`Kobo: the Kobo store's library sync answered ${response.status}`);
          }
        } catch (error) {
          console.warn(`Kobo: syncing shelf books only, because the Kobo store did not answer: ${error.message}`);
        }
      }

      res.setHeader("x-kobo-synctoken", encodeSyncToken({ since: nextSince, storeToken }));
      if (more || storeContinues) res.setHeader("x-kobo-sync", "continue");
      res.json(results);
    } catch (error) {
      next(error);
    }
  });

  router.get("/v1/library/:koboId/metadata", async (req, res, next) => {
    try {
      const entry = findEntry(req, req.params.koboId);
      if (!entry) {
        await proxy(req, res, (reply) => reply.status(404).json({ error: "Book not found" }));
        return;
      }
      if (!entry.book) {
        res.status(404).json({ error: "Book not found" });
        return;
      }
      res.json([await bookMetadata(req, entry, await kepub.fileFor(entry.book))]);
    } catch (error) {
      next(error);
    }
  });

  router.get("/v1/library/:koboId/state", async (req, res, next) => {
    try {
      const entry = findEntry(req, req.params.koboId);
      if (!entry) {
        await proxy(req, res, (reply) => reply.status(404).json({ error: "Book not found" }));
        return;
      }
      if (!entry.book) {
        res.status(404).json({ error: "Book not found" });
        return;
      }
      res.json([await readingState(req.koboUser.id, entry, await kepub.fileFor(entry.book, { convertIfMissing: false }))]);
    } catch (error) {
      next(error);
    }
  });

  router.put("/v1/library/:koboId/state", async (req, res, next) => {
    try {
      const entry = findEntry(req, req.params.koboId);
      if (!entry) {
        await proxy(req, res, (reply) => reply.status(404).json({ error: "Book not found" }));
        return;
      }
      if (!entry.book) {
        res.status(404).json({ error: "Book not found" });
        return;
      }
      let body = null;
      try {
        body = JSON.parse(bodyText(req));
      } catch {
        body = null;
      }
      const incoming = body?.ReadingStates?.find((state) => !state.EntitlementId || state.EntitlementId === entry.koboId) || body?.ReadingStates?.[0];
      if (!incoming) {
        res.status(400).json({ error: "No reading state was sent" });
        return;
      }
      const userId = req.koboUser.id;
      const bookId = entry.book.id;
      const previous = store.getKoboReadingState(userId, bookId) || {};
      const next = {
        ...previous,
        LastModified: incoming.LastModified || koboTimestamp(),
        StatusInfo: { ...(previous.StatusInfo || {}), ...(incoming.StatusInfo || {}) },
        Statistics: { ...(previous.Statistics || {}), ...(incoming.Statistics || {}) },
        CurrentBookmark: incoming.CurrentBookmark ? { ...incoming.CurrentBookmark } : previous.CurrentBookmark
      };
      const result = { EntitlementId: entry.koboId, StatusInfoResult: { Result: "Success" }, StatisticsResult: { Result: "Success" } };
      if (incoming.CurrentBookmark || incoming.StatusInfo) {
        const file = await kepub.fileFor(entry.book, { convertIfMissing: false });
        const spine = file ? await readEpubSpine(file.sourcePath).catch(() => []) : [];
        const update = progressFromKoboBookmark(next.CurrentBookmark, next.StatusInfo?.Status, spine);
        const progress = await store.setProgress(userId, bookId, update);
        next.shelfProgressUpdatedAt = progress.updatedAt;
        result.CurrentBookmarkResult = { Result: "Success" };
      }
      await store.setKoboReadingState(userId, bookId, next);
      res.json({ RequestResult: "Success", UpdateResults: [result] });
    } catch (error) {
      next(error);
    }
  });

  // "Remove from library" on the Kobo takes the book off this reader's Kobo list.
  router.delete("/v1/library/:koboId", async (req, res, next) => {
    try {
      const entry = findEntry(req, req.params.koboId);
      if (!entry) {
        await proxy(req, res, (reply) => reply.status(404).json({ error: "Book not found" }));
        return;
      }
      await store.setOnKobo(req.koboUser.id, entry.row.bookId, false);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/download/:koboId/:format", async (req, res, next) => {
    try {
      const entry = findEntry(req, req.params.koboId);
      if (!entry?.book) {
        res.status(404).json({ error: "Book not found" });
        return;
      }
      const file = await kepub.fileFor(entry.book, { convertIfMissing: req.params.format === "kepub" });
      if (!file) {
        res.status(404).json({ error: "Book file not found" });
        return;
      }
      streamFile(req, res, file.path, "application/epub+zip");
    } catch (error) {
      next(error);
    }
  });

  // Covers: shelf's own books are served here; anything else goes to Kobo's image server.
  router.get(/^\/([^/]+)\/(.+)\/image\.jpg$/, (req, res) => {
    const imageId = req.params[0];
    const entry = findEntry(req, imageId);
    if (entry?.book?.coverPath) {
      streamFile(req, res, entry.book.coverPath, entry.book.coverMime || "image/jpeg");
      return;
    }
    if (entry) {
      res.status(404).end();
      return;
    }
    res.redirect(302, `${KOBO_IMAGE_HOST}/${encodeURIComponent(imageId)}/${req.params[1]}/image.jpg`);
  });

  // Calls about shelf's own books that only make sense for store books.
  router.all(/^\/v1\/(?:library|products)\/([0-9a-f-]{36})(?:\/.*)?$/i, async (req, res) => {
    if (findEntry(req, req.params[0])) {
      res.json({});
      return;
    }
    await proxy(req, res, emptyObject);
  });

  router.all(/.*/, (req, res) => proxy(req, res, emptyObject));

  return router;
}

function bodyText(req) {
  return Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
}

function parseSeries(value) {
  if (!value) return null;
  const text = typeof value === "string" ? value : value.name || "";
  if (!text) return null;
  const explicit = typeof value === "object" && Number.isFinite(Number(value.number)) ? Number(value.number) : null;
  const match = /^(.*?)(?:\s*[#,]\s*|\s+(?:book|vol\.?|volume)\s+)(\d+(?:\.\d+)?)\s*$/i.exec(text);
  return match ? { name: match[1].trim(), number: explicit ?? Number(match[2]) } : { name: text.trim(), number: explicit };
}

function latest(...values) {
  let best = null;
  for (const value of values) {
    if (value && (!best || Date.parse(value) > Date.parse(best))) best = value;
  }
  return best || new Date().toISOString();
}

export function requestOrigin(req, publicUrl = "") {
  const host = req.get("host");
  try {
    const configured = publicUrl ? new URL(publicUrl) : null;
    if (configured && configured.host === host) {
      return configured.origin;
    }
  } catch {
    // Not a usable URL.
  }
  return `${req.protocol}://${host}`;
}

// Used when the Kobo store can't be reached, so the device still finds shelf's sync and covers.
const FALLBACK_RESOURCES = {
  library_sync: `${KOBO_STORE_URL}/v1/library/sync`,
  library_items: `${KOBO_STORE_URL}/v1/user/library`,
  library_book: `${KOBO_STORE_URL}/v1/user/library/books/{LibraryItemId}`,
  library_metadata: `${KOBO_STORE_URL}/v1/library/{Ids}/metadata`,
  library_prices: `${KOBO_STORE_URL}/v1/user/library/previews/prices`,
  library_search: `${KOBO_STORE_URL}/v1/library/search`,
  library_stack: `${KOBO_STORE_URL}/v1/user/library/stacks/{LibraryItemId}`,
  reading_state: `${KOBO_STORE_URL}/v1/library/{Ids}/state`,
  delete_entry: `${KOBO_STORE_URL}/v1/library/{Ids}`,
  get_tests_request: `${KOBO_STORE_URL}/v1/analytics/gettests`,
  post_analytics_event: `${KOBO_STORE_URL}/v1/analytics/event`,
  user_profile: `${KOBO_STORE_URL}/v1/user/profile`,
  user_loyalty_benefits: `${KOBO_STORE_URL}/v1/user/loyalty/benefits`,
  device_auth: `${KOBO_STORE_URL}/v1/auth/device`,
  device_refresh: `${KOBO_STORE_URL}/v1/auth/refresh`,
  image_host: "https://cdn.kobo.com/book-images/",
  image_url_template: `${KOBO_IMAGE_HOST}/{ImageId}/{Width}/{Height}/false/image.jpg`,
  image_url_quality_template: `${KOBO_IMAGE_HOST}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`
};
