import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

// Libby has no public API. These are the private endpoints Libby's own web app uses, as
// documented by the open-source odmpy and libby-calibre-plugin projects. They can change
// without notice, and using them is against OverDrive's terms; each user opts in by linking.
const LIBBY_API = "https://sentry-read.svc.overdrive.com/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const SYNC_TTL_MS = 2 * 60 * 1000;
const AUDIO_SESSION_TTL_MS = 30 * 60 * 1000;
const BOOK_ID_PATTERN = /^libby-([A-Za-z0-9]+)-([A-Za-z0-9]+)$/;

export const LIBBY_BOOK_PREFIX = "libby-";

export class LibbyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "LibbyError";
    this.status = status;
  }
}

export function isValidSetupCode(code) {
  return /^\d{8}$/.test(String(code || ""));
}

export function libbyBookId(cardId, titleId) {
  return `${LIBBY_BOOK_PREFIX}${cardId}-${titleId}`;
}

export function parseLibbyBookId(bookId) {
  const match = BOOK_ID_PATTERN.exec(String(bookId || ""));
  return match ? { cardId: match[1], titleId: match[2] } : null;
}

export function createLibbyApi({ fetchImpl = globalThis.fetch } = {}) {
  async function send(url, { token, method = "GET", form, headers = {}, cookies } = {}) {
    const requestHeaders = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Referer: "https://libbyapp.com/",
      ...headers
    };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (cookies) requestHeaders.Cookie = cookies;
    let body;
    if (form) {
      requestHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    let response;
    try {
      response = await fetchImpl(new URL(url, LIBBY_API), { method, headers: requestHeaders, body, redirect: "manual" });
    } catch (error) {
      throw new LibbyError(`Couldn't reach Libby: ${error.message}`);
    }
    return response;
  }

  // 409 rather than 401, because a 401 from shelf signs the person out of shelf itself.
  async function json(url, options) {
    const response = await send(url, options);
    if (response.status === 401 || response.status === 403) {
      throw new LibbyError("Libby no longer accepts this link. Link Libby again with a new setup code.", 409);
    }
    if (!response.ok) {
      throw new LibbyError(`Libby returned an error (${response.status})`);
    }
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : {};
  }

  return {
    send,
    createChip: () => json("chip?client=dewey", { method: "POST" }),
    cloneByCode: (token, code) => json("chip/clone/code", { token, method: "POST", form: { code } }),
    sync: (token) => json("chip/sync", { token }),
    openLoan: (token, type, cardId, titleId) =>
      json(`open/${type}/card/${encodeURIComponent(cardId)}/title/${encodeURIComponent(titleId)}`, { token }),
    getJson: (url, token, cookies) => json(url, { token, cookies }),

    // Libby's web player sets a cookie on its own domain before it will hand out audio parts.
    async startWebSession(webUrl) {
      let url = webUrl;
      const jar = new Map();
      for (let hop = 0; hop < 6; hop += 1) {
        const response = await send(url, { headers: { Accept: "*/*" } });
        for (const cookie of response.headers.getSetCookie?.() || []) {
          const [pair] = cookie.split(";");
          const separator = pair.indexOf("=");
          if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
        }
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          url = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) {
          throw new LibbyError(`Libby wouldn't open this loan (${response.status})`);
        }
        break;
      }
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },

    // Open (DRM-free) EPUB and PDF loans redirect to the actual file.
    async fetchOpenFile(token, cardId, loanId, formatId) {
      let response = await send(`card/${encodeURIComponent(cardId)}/loan/${encodeURIComponent(loanId)}/fulfill/${formatId}`, {
        token,
        headers: { Accept: "*/*" }
      });
      for (let hop = 0; hop < 6 && response.status >= 300 && response.status < 400; hop += 1) {
        const location = response.headers.get("location");
        if (!location) break;
        response = await send(new URL(location, response.url || LIBBY_API).toString(), { headers: { Accept: "*/*" } });
      }
      if (!response.ok) {
        throw new LibbyError(`Libby wouldn't hand over this book (${response.status})`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
  };
}

// Picks how shelf can open a loan. Adobe DRM and Kindle loans stay in Libby: shelf never unlocks them.
export function loanReadingMode(loan) {
  const formats = Array.isArray(loan?.formats) ? loan.formats : [];
  const ids = new Set(formats.map((format) => format.id));
  const lockedIn = formats.find((format) => format.isLockedIn)?.id || null;
  const type = loan?.type?.id;
  if (type === "audiobook") {
    return (!lockedIn || lockedIn === "audiobook-mp3") && ids.has("audiobook-mp3") ? "audio" : "libby";
  }
  if (type === "ebook") {
    if (lockedIn) {
      return lockedIn === "ebook-epub-open" ? "epub" : lockedIn === "ebook-pdf-open" ? "pdf" : "libby";
    }
    if (ids.has("ebook-epub-open")) return "epub";
    if (ids.has("ebook-pdf-open")) return "pdf";
  }
  return "libby";
}

export function libbyLoanUrl(loan, cards = []) {
  const card = cards.find((item) => String(item.cardId) === String(loan.cardId));
  return card?.advantageKey
    ? `https://libbyapp.com/library/${encodeURIComponent(card.advantageKey)}/everything/page-1/${encodeURIComponent(loan.id)}`
    : "https://libbyapp.com/shelf/loans/default";
}

function bestCover(loan) {
  const covers = Object.values(loan?.covers || {}).filter((cover) => cover?.href);
  covers.sort((a, b) => (b.width || 0) - (a.width || 0));
  const href = covers[0]?.href || null;
  return href ? href.replace(/^http:\/\//, "https://") : null;
}

function plainText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

export function loanToBook(loan, cards, progress) {
  const mode = loanReadingMode(loan);
  const card = cards.find((item) => String(item.cardId) === String(loan.cardId));
  const mediaType = loan?.type?.id === "audiobook" ? "audiobook" : "ebook";
  const checkedOut = loan.checkoutDate || new Date().toISOString();
  return {
    id: libbyBookId(loan.cardId, loan.id),
    title: loan.title || "Untitled",
    subtitle: loan.subtitle || null,
    series: loan.detailedSeries?.seriesName || loan.series || null,
    author: loan.firstCreatorName || "Unknown author",
    sortTitle: loan.sortTitle || null,
    publisher: loan.publisherAccount?.name || null,
    publicationDate: loan.publishDate || null,
    language: null,
    isbnAsin: null,
    description: plainText(loan.description),
    pageCount: null,
    categories: (loan.subjects || []).map((subject) => subject.name).filter(Boolean),
    contributors: [],
    narrator: null,
    filename: loan.title || "Libby loan",
    relPath: "",
    ext: mode === "pdf" ? ".pdf" : mode === "epub" ? ".epub" : mediaType === "audiobook" ? ".mp3" : "",
    size: 0,
    status: mode === "libby" ? "unsupported" : "ready",
    readingFormat: mode === "libby" ? null : mode,
    canConvert: false,
    mediaType,
    durationSeconds: null,
    trackCount: null,
    coverUrl: bestCover(loan),
    addedAt: checkedOut,
    updatedAt: checkedOut,
    error: null,
    progress: progress || null,
    libby: {
      titleId: String(loan.id),
      cardId: String(loan.cardId),
      libraryName: card?.library?.name || card?.cardName || "Libby",
      dueAt: loan.expireDate || loan.expires || null,
      mode,
      libbyUrl: libbyLoanUrl(loan, cards)
    }
  };
}

// Libby audiobooks come as a few long MP3 parts; each part becomes one track in shelf's player.
export function audiobookTracks(openbook, webUrl) {
  const toc = Array.isArray(openbook?.nav?.toc) ? openbook.nav.toc : [];
  const firstChapterByPart = new Map();
  for (const item of toc) {
    for (const entry of [item, ...(item.contents || [])]) {
      const part = String(entry.path || "").split("#")[0];
      if (part && !firstChapterByPart.has(part) && item.title) firstChapterByPart.set(part, item.title);
    }
  }
  return (openbook?.spine || []).map((part, index) => {
    const original = part["-odread-original-path"] || part.path;
    return {
      index,
      title: firstChapterByPart.get(original) || `Part ${index + 1}`,
      filename: `Part ${String(index + 1).padStart(2, "0")}.mp3`,
      durationSeconds: Number(part["audio-duration"]) || null,
      upstreamUrl: new URL(part.path, webUrl).toString()
    };
  });
}

export class LibbyService {
  constructor(store, dataDir, { api = createLibbyApi(), now = () => Date.now() } = {}) {
    this.store = store;
    this.api = api;
    this.now = now;
    this.cacheDir = path.join(dataDir, "libby-cache");
    this.key = crypto.createHash("sha256").update(loadSecret(path.join(dataDir, "libby-secret"))).digest();
    this.syncCache = new Map();
    this.audioSessions = new Map();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
  }

  decrypt(value) {
    const [iv, tag, data] = String(value || "").split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  }

  token(userId) {
    const account = this.store.getLibbyAccount(userId);
    if (!account) throw new LibbyError("Link your Libby account first", 409);
    try {
      return this.decrypt(account.identity).token;
    } catch {
      throw new LibbyError("Link Libby again with a new setup code", 409);
    }
  }

  async link(userId, code) {
    const trimmed = String(code || "").replace(/\s+/g, "");
    if (!isValidSetupCode(trimmed)) {
      throw new LibbyError("Enter the 8-digit setup code from Libby", 400);
    }
    const chip = await this.api.createChip();
    if (!chip?.identity) throw new LibbyError("Libby didn't start a session");
    try {
      await this.api.cloneByCode(chip.identity, trimmed);
    } catch (error) {
      throw new LibbyError("Libby didn't accept that code. Codes only last a short while, so get a new one and try again.", 400);
    }
    const state = await this.api.sync(chip.identity);
    if (state?.result !== "synchronized" || !state.cards?.length) {
      throw new LibbyError("That Libby account has no library cards yet. Add a card in Libby, then link again.", 400);
    }
    await this.store.setLibbyAccount(userId, this.encrypt({ token: chip.identity }));
    this.syncCache.set(userId, { at: this.now(), state });
    return this.status(userId);
  }

  async unlink(userId) {
    await this.store.deleteLibbyAccount(userId);
    this.syncCache.delete(userId);
    this.dropAudioSessions(userId);
    await fs.rm(this.userCacheDir(userId), { recursive: true, force: true });
  }

  status(userId) {
    const account = this.store.getLibbyAccount(userId);
    const cards = this.syncCache.get(userId)?.state?.cards || [];
    return {
      linked: Boolean(account),
      linkedAt: account?.linkedAt || null,
      libraries: cards.map((card) => card.library?.name || card.cardName).filter(Boolean)
    };
  }

  async state(userId, { force = false } = {}) {
    const cached = this.syncCache.get(userId);
    if (!force && cached && this.now() - cached.at < SYNC_TTL_MS) {
      return cached.state;
    }
    const state = await this.api.sync(this.token(userId));
    this.syncCache.set(userId, { at: this.now(), state });
    await this.cleanUpReturnedLoans(userId, state);
    return state;
  }

  async loans(userId, options) {
    const state = await this.state(userId, options);
    const cards = state.cards || [];
    return (state.loans || [])
      .filter((loan) => loan?.type?.id === "audiobook" || loan?.type?.id === "ebook")
      .map((loan) => {
        const id = libbyBookId(loan.cardId, loan.id);
        return loanToBook(loan, cards, this.store.getProgress(userId, id));
      });
  }

  async findLoan(userId, bookId) {
    const parsed = parseLibbyBookId(bookId);
    if (!parsed) return null;
    const lookup = (state) =>
      (state.loans || []).find((loan) => String(loan.cardId) === parsed.cardId && String(loan.id) === parsed.titleId);
    let state = await this.state(userId);
    let loan = lookup(state);
    if (!loan) {
      state = await this.state(userId, { force: true });
      loan = lookup(state);
    }
    return loan ? { loan, book: loanToBook(loan, state.cards || [], this.store.getProgress(userId, bookId)) } : null;
  }

  async audioSession(userId, loan, { fresh = false } = {}) {
    const key = `${userId}:${loan.cardId}:${loan.id}`;
    const existing = this.audioSessions.get(key);
    if (!fresh && existing && this.now() - existing.at < AUDIO_SESSION_TTL_MS) {
      return existing;
    }
    const token = this.token(userId);
    const meta = await this.api.openLoan(token, "audiobook", loan.cardId, loan.id);
    const webUrl = meta?.urls?.web;
    if (!webUrl || !meta?.urls?.openbook) throw new LibbyError("Libby didn't return this audiobook");
    const cookies = await this.api.startWebSession(`${webUrl}?${meta.message || ""}`);
    const openbook = await this.api.getJson(meta.urls.openbook, token, cookies);
    const session = { at: this.now(), cookies, tracks: audiobookTracks(openbook, webUrl) };
    this.audioSessions.set(key, session);
    return session;
  }

  dropAudioSessions(userId) {
    for (const key of this.audioSessions.keys()) {
      if (key.startsWith(`${userId}:`)) this.audioSessions.delete(key);
    }
  }

  // Streams one MP3 part straight from Libby, passing range requests through so seeking works.
  async streamAudio(req, res, userId, loan, trackIndex) {
    for (const fresh of [false, true]) {
      const session = await this.audioSession(userId, loan, { fresh });
      const track = session.tracks[trackIndex];
      if (!track) {
        res.status(404).json({ error: "Audio track not found" });
        return;
      }
      const headers = { Accept: "*/*" };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await this.api.send(track.upstreamUrl, { headers, cookies: session.cookies });
      if ((upstream.status === 401 || upstream.status === 403) && !fresh) {
        await upstream.body?.cancel();
        continue;
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        res.status(502).json({ error: `Libby wouldn't stream this part (${upstream.status})` });
        return;
      }
      res.status(upstream.status);
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (!upstream.headers.get("content-type")) res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "private, no-store");
      const body = Readable.fromWeb(upstream.body);
      req.on("close", () => body.destroy());
      body.pipe(res);
      return;
    }
  }

  userCacheDir(userId) {
    return path.join(this.cacheDir, crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32));
  }

  // Open EPUB/PDF loans are kept only while the loan lasts.
  async openFilePath(userId, loan, mode) {
    const dir = this.userCacheDir(userId);
    const filePath = path.join(dir, `${libbyBookId(loan.cardId, loan.id)}.${mode}`);
    if (fsSync.existsSync(filePath)) return filePath;
    const formatId = mode === "pdf" ? "ebook-pdf-open" : "ebook-epub-open";
    const data = await this.api.fetchOpenFile(this.token(userId), loan.cardId, loan.id, formatId);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, filePath);
    return filePath;
  }

  async cleanUpReturnedLoans(userId, state) {
    const dir = this.userCacheDir(userId);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const current = new Set((state.loans || []).map((loan) => libbyBookId(loan.cardId, loan.id)));
    await Promise.all(entries
      .filter((name) => !current.has(name.replace(/\.(epub|pdf)$/, "")))
      .map((name) => fs.rm(path.join(dir, name), { force: true })));
  }
}

function loadSecret(filePath) {
  try {
    const existing = fsSync.readFileSync(filePath);
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const secret = crypto.randomBytes(48);
  fsSync.writeFileSync(filePath, secret, { mode: 0o600 });
  return secret;
}
