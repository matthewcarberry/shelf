import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";

export const DEFAULT_PREFERENCES = {
  fontSize: 110,
  fontFamily: "Georgia",
  alignment: "left",
  lineHeight: 1.55,
  theme: "paper",
  pageLayout: "single",
  margin: "medium",
  kindleEmail: "",
  skipForwardSeconds: 30,
  skipBackSeconds: 30,
  progressDisplay: {
    chapterTime: true,
    pageInBook: true,
    bookTime: true
  }
};

const EMPTY_DB = {
  books: {},
  users: {},
  progress: {},
  bookmarks: {},
  highlights: {},
  preferences: {},
  reviews: {},
  dictionaryCache: {},
  mobileTokens: {}
};

const SQLITE_FILENAME = "shelfstream.sqlite";
const LEGACY_BACKUP_SUFFIX = ".pre-sqlite-backup";
const CURRENT_SCHEMA_VERSION = 6;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class SqliteStore {
  constructor(dbFile) {
    this.legacyDbFile = dbFile;
    this.sqliteFile = path.join(path.dirname(dbFile), SQLITE_FILENAME);
    this.db = clone(EMPTY_DB);
    this.writeQueue = Promise.resolve();
    this.sqlite = null;
    this.serverIdentity = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.sqliteFile), { recursive: true });
    const sqliteExisted = fsSync.existsSync(this.sqliteFile);

    try {
      this.sqlite = new DatabaseSync(this.sqliteFile);
      configureSqlite(this.sqlite);
      applySchemaMigrations(this.sqlite);

      if (!databaseIsInitialized(this.sqlite)) {
        if (fsSync.existsSync(this.legacyDbFile)) {
          await this.importLegacyJson();
        } else {
          writeDatabaseState(this.sqlite, this.db);
        }
      } else {
        this.db = readDatabaseState(this.sqlite);
      }

      this.serverIdentity = ensureServerIdentity(this.sqlite);
      await fs.chmod(this.sqliteFile, 0o600).catch(() => undefined);
    } catch (error) {
      this.close();
      if (!sqliteExisted && fsSync.existsSync(this.sqliteFile)) {
        const failedPath = `${this.sqliteFile}.failed-${Date.now()}`;
        await fs.rename(this.sqliteFile, failedPath).catch(() => undefined);
      }
      throw error;
    }
  }

  async save() {
    return this.queueSqliteWrite((sqlite) => {
      writeDatabaseState(sqlite, this.db);
    });
  }

  async queueSqliteWrite(write) {
    this.writeQueue = this.writeQueue.then(() => {
      if (!this.sqlite) {
        throw new Error("Shelf SQLite store is not initialized");
      }
      write(this.sqlite);
    });
    return this.writeQueue;
  }

  async importLegacyJson() {
    const raw = await fs.readFile(this.legacyDbFile, "utf8");
    const existing = raw.trim() ? JSON.parse(raw) : {};
    const migrated = normalizeDatabase(existing);
    const backupPath = `${this.legacyDbFile}${LEGACY_BACKUP_SUFFIX}`;

    if (!fsSync.existsSync(backupPath)) {
      await fs.copyFile(this.legacyDbFile, backupPath, fsSync.constants.COPYFILE_EXCL);
    }

    writeDatabaseState(this.sqlite, migrated, {
      legacySource: this.legacyDbFile,
      legacyBackup: backupPath,
      importedAt: new Date().toISOString()
    });
    const persisted = readDatabaseState(this.sqlite);
    assertMigrationCounts(migrated, persisted);
    this.db = persisted;
  }

  getServerIdentity() {
    if (!this.serverIdentity) {
      throw new Error("Shelf server identity is not initialized");
    }
    return { ...this.serverIdentity };
  }

  getPublicServerIdentity() {
    const identity = this.getServerIdentity();
    return {
      serverId: identity.serverId,
      publicKey: identity.publicKey,
      createdAt: identity.createdAt
    };
  }

  getStorageInfo() {
    return {
      engine: "sqlite",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      databaseFile: this.sqliteFile,
      legacyBackupFile: `${this.legacyDbFile}${LEGACY_BACKUP_SUFFIX}`
    };
  }

  close() {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
  }

  hasUsers() {
    return Object.keys(this.db.users).length > 0;
  }

  listUsers() {
    return Object.values(this.db.users)
      .map(publicUser)
      .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
  }

  getUser(userId) {
    return this.db.users[userId] || null;
  }

  getPublicUser(userId) {
    const user = this.getUser(userId);
    return user ? publicUser(user) : null;
  }

  findUserByUsername(username) {
    const normalized = normalizeUsername(username);
    return (
      Object.values(this.db.users).find(
        (user) => user.username.toLowerCase() === normalized.toLowerCase()
      ) || null
    );
  }

  async createUser({ username, displayName, passwordHash, role = "reader" }) {
    const normalized = normalizeUsername(username);
    if (!normalized) {
      throw new Error("Username is required");
    }
    if (!passwordHash) {
      throw new Error("Password hash is required");
    }
    if (this.findUserByUsername(normalized)) {
      throw new Error("Username already exists");
    }

    const user = {
      id: nanoid(12),
      username: normalized,
      displayName: String(displayName || normalized).trim(),
      passwordHash,
      role: role === "admin" ? "admin" : "reader",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.db.users[user.id] = user;
    await this.save();
    return publicUser(user);
  }

  async ensurePlatformUser({ accountId, username, displayName, role = "reader" }) {
    const existingByAccount = Object.values(this.db.users).find(
      (user) => user.platformAccountId === accountId || user.id === accountId
    );
    if (existingByAccount) {
      const nextRole = role === "owner" || role === "admin" ? "admin" : "reader";
      const updated = {
        ...existingByAccount,
        platformAccountId: accountId,
        displayName: String(displayName || existingByAccount.displayName || username).trim(),
        role: nextRole,
        updatedAt: new Date().toISOString()
      };
      this.db.users[existingByAccount.id] = updated;
      await this.save();
      return publicUser(updated);
    }

    let normalized = normalizeUsername(username) || `member-${String(accountId).slice(-6)}`;
    const conflict = this.findUserByUsername(normalized);
    if (conflict) {
      normalized = `${normalized}-${String(accountId).slice(-5).toLowerCase()}`;
    }
    const now = new Date().toISOString();
    const user = {
      id: accountId,
      platformAccountId: accountId,
      username: normalized,
      displayName: String(displayName || normalized).trim(),
      passwordHash: `platform:${crypto.randomBytes(32).toString("base64url")}`,
      role: role === "owner" || role === "admin" ? "admin" : "reader",
      createdAt: now,
      updatedAt: now
    };
    this.db.users[user.id] = user;
    await this.save();
    return publicUser(user);
  }

  async updateUser(userId, patch) {
    const user = this.getUser(userId);
    if (!user) {
      return null;
    }

    const next = {
      ...user,
      displayName: patch.displayName === undefined ? user.displayName : String(patch.displayName).trim(),
      role: patch.role === "admin" ? "admin" : patch.role === "reader" ? "reader" : user.role,
      updatedAt: new Date().toISOString()
    };

    this.db.users[userId] = next;
    await this.save();
    return publicUser(next);
  }

  async setUserPassword(userId, passwordHash) {
    const user = this.getUser(userId);
    if (!user) {
      return null;
    }

    this.db.users[userId] = {
      ...user,
      passwordHash,
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return publicUser(this.db.users[userId]);
  }

  async deleteUser(userId) {
    if (!this.db.users[userId]) {
      return false;
    }

    delete this.db.users[userId];
    delete this.db.progress[userId];
    delete this.db.bookmarks[userId];
    delete this.db.highlights[userId];
    delete this.db.preferences[userId];
    delete this.db.reviews[userId];
    for (const [tokenHash, token] of Object.entries(this.db.mobileTokens)) {
      if (token?.userId === userId) {
        delete this.db.mobileTokens[tokenHash];
      }
    }
    await this.save();
    await this.queueSqliteWrite((sqlite) => {
      sqlite.prepare("DELETE FROM profile_usage WHERE user_id = ?").run(userId);
      sqlite.prepare("DELETE FROM read_list WHERE user_id = ?").run(userId);
    });
    return true;
  }

  getMobileToken(tokenHash) {
    return this.db.mobileTokens[tokenHash] || null;
  }

  async saveMobileToken(tokenHash, token) {
    this.db.mobileTokens[tokenHash] = token;
    await this.save();
    return token;
  }

  async deleteMobileToken(tokenHash) {
    if (!this.db.mobileTokens[tokenHash]) {
      return false;
    }
    delete this.db.mobileTokens[tokenHash];
    await this.save();
    return true;
  }

  listBooks() {
    return Object.values(this.db.books).sort((a, b) =>
      bookSortTitle(a).localeCompare(bookSortTitle(b), undefined, { sensitivity: "base" })
    );
  }

  getBook(bookId) {
    return this.db.books[bookId] || null;
  }

  async upsertBook(book) {
    const existing = this.db.books[book.id] || {};
    const manualMetadata = existing.metadataUpdatedAt
      ? {
          title: existing.title,
          subtitle: existing.subtitle || null,
          series: existing.series || null,
          author: existing.author,
          sortTitle: existing.sortTitle || null,
          publisher: existing.publisher || null,
          publicationDate: existing.publicationDate || null,
          language: existing.language || null,
          isbnAsin: existing.isbnAsin || null,
          description: existing.description || null,
          pageCount: existing.pageCount || null,
          categories: existing.categories || [],
          contributors: existing.contributors || [],
          narrator: existing.narrator || null,
          metadataUpdatedAt: existing.metadataUpdatedAt
        }
      : {};
    this.db.books[book.id] = {
      ...existing,
      ...book,
      ...manualMetadata,
      addedAt: existing.addedAt || book.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return this.db.books[book.id];
  }

  async updateBookMetadata(bookId, metadata) {
    const book = this.getBook(bookId);
    if (!book) {
      return null;
    }

    this.db.books[bookId] = {
      ...book,
      title: String(metadata.title || book.title).trim(),
      subtitle: String(metadata.subtitle || "").trim() || null,
      series: String(metadata.series || "").trim() || null,
      author: String(metadata.author || "Unknown author").trim(),
      sortTitle: String(metadata.sortTitle || "").trim() || null,
      publisher: String(metadata.publisher || "").trim() || null,
      publicationDate: String(metadata.publicationDate || "").trim() || null,
      language: String(metadata.language || "").trim() || null,
      isbnAsin: String(metadata.isbnAsin || "").trim() || null,
      description: String(metadata.description || "").trim() || null,
      pageCount: Number.isInteger(metadata.pageCount) && metadata.pageCount > 0 ? metadata.pageCount : null,
      categories: Array.isArray(metadata.categories) ? metadata.categories : [],
      contributors: Array.isArray(metadata.contributors) ? metadata.contributors : [],
      narrator: String(metadata.narrator || "").trim() || null,
      metadataUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return this.db.books[bookId];
  }

  async patchBook(bookId, patch) {
    if (!this.db.books[bookId]) {
      return null;
    }
    this.db.books[bookId] = {
      ...this.db.books[bookId],
      ...patch,
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return this.db.books[bookId];
  }

  async deleteBook(bookId) {
    if (!this.db.books[bookId]) {
      return false;
    }

    delete this.db.books[bookId];
    for (const bucket of [this.db.progress, this.db.bookmarks, this.db.highlights, this.db.reviews]) {
      for (const userBucket of Object.values(bucket)) {
        if (userBucket && typeof userBucket === "object") {
          delete userBucket[bookId];
        }
      }
    }
    await this.save();
    await this.queueSqliteWrite((sqlite) => {
      sqlite.prepare("DELETE FROM read_list WHERE book_id = ?").run(bookId);
    });
    return true;
  }

  getProgress(userId, bookId) {
    return this.db.progress[userId]?.[bookId] || null;
  }

  async setProgress(userId, bookId, progress) {
    const bucket = ensureNested(this.db.progress, userId);
    const next = {
      ...(bucket[bookId] || {}),
      ...progress,
      percent: clampNumber(progress.percent, 0, 1),
      updatedAt: new Date().toISOString()
    };
    bucket[bookId] = next;
    await this.save();
    return next;
  }

  listUserProgress(userId) {
    return Object.entries(this.db.progress[userId] || {}).map(([bookId, progress]) => ({
      bookId,
      progress: clone(progress)
    }));
  }

  listBookmarks(userId, bookId) {
    return this.db.bookmarks[userId]?.[bookId] || [];
  }

  async addBookmark(userId, bookId, bookmark) {
    const bucket = ensureNested(this.db.bookmarks, userId);
    const next = {
      id: nanoid(10),
      bookId,
      userId,
      label: bookmark.label || "Bookmark",
      locator: bookmark.locator || null,
      page: bookmark.page || null,
      percent: clampNumber(bookmark.percent || 0, 0, 1),
      createdAt: new Date().toISOString()
    };
    bucket[bookId] = [next, ...(bucket[bookId] || [])];
    await this.save();
    return next;
  }

  async deleteBookmark(userId, bookId, bookmarkId) {
    const bucket = ensureNested(this.db.bookmarks, userId);
    bucket[bookId] = (bucket[bookId] || []).filter((item) => item.id !== bookmarkId);
    await this.save();
  }

  listHighlights(userId, bookId) {
    return this.db.highlights[userId]?.[bookId] || [];
  }

  async addHighlight(userId, bookId, highlight) {
    const text = String(highlight.text || "").trim();
    const bucket = ensureNested(this.db.highlights, userId);
    const next = {
      id: nanoid(10),
      bookId,
      userId,
      text,
      locator: highlight.locator || null,
      page: highlight.page || null,
      note: String(highlight.note || "").trim(),
      color: highlight.color || "gold",
      percent: clampNumber(highlight.percent || 0, 0, 1),
      createdAt: new Date().toISOString()
    };
    bucket[bookId] = [next, ...(bucket[bookId] || [])];
    await this.save();
    return next;
  }

  async deleteHighlight(userId, bookId, highlightId) {
    const bucket = ensureNested(this.db.highlights, userId);
    bucket[bookId] = (bucket[bookId] || []).filter((item) => item.id !== highlightId);
    await this.save();
  }

  listUserHighlights(userId) {
    return Object.entries(this.db.highlights[userId] || {}).flatMap(([bookId, highlights]) =>
      (highlights || []).map((highlight) => ({ bookId, highlight: clone(highlight) }))
    );
  }

  listUserReviews(userId) {
    return Object.entries(this.db.reviews[userId] || {}).map(([bookId, review]) => ({
      bookId,
      review: clone(review)
    }));
  }

  getProfileUsage(userId) {
    if (!this.sqlite) {
      throw new Error("Shelf SQLite store is not initialized");
    }
    const row = this.sqlite.prepare(`
      SELECT reading_seconds, listening_seconds, updated_at
      FROM profile_usage
      WHERE user_id = ?
    `).get(userId);
    return {
      readingSeconds: Number(row?.reading_seconds || 0),
      listeningSeconds: Number(row?.listening_seconds || 0),
      updatedAt: row?.updated_at || null
    };
  }

  async recordProfileUsage(userId, mediaType, seconds) {
    const safeSeconds = Math.min(120, Math.max(1, Math.round(Number(seconds) || 0)));
    const column = mediaType === "audiobook" ? "listening_seconds" : "reading_seconds";
    const now = new Date().toISOString();
    await this.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO profile_usage (user_id, reading_seconds, listening_seconds, updated_at)
        VALUES (?, 0, 0, ?)
        ON CONFLICT(user_id) DO NOTHING
      `).run(userId, now);
      sqlite.prepare(`
        UPDATE profile_usage
        SET ${column} = ${column} + ?, updated_at = ?
        WHERE user_id = ?
      `).run(safeSeconds, now, userId);
    });
    return this.getProfileUsage(userId);
  }

  listReadList(userId) {
    if (!this.sqlite) {
      throw new Error("Shelf SQLite store is not initialized");
    }
    return this.sqlite.prepare(`
      SELECT book_id, added_at
      FROM read_list
      WHERE user_id = ?
      ORDER BY added_at DESC
    `).all(userId).map((row) => ({
      bookId: row.book_id,
      addedAt: row.added_at
    }));
  }

  async addToReadList(userId, bookId) {
    const addedAt = new Date().toISOString();
    await this.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO read_list (user_id, book_id, added_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET added_at = excluded.added_at
      `).run(userId, bookId, addedAt);
    });
    return { bookId, addedAt };
  }

  async removeFromReadList(userId, bookId) {
    let removed = false;
    await this.queueSqliteWrite((sqlite) => {
      removed = sqlite.prepare("DELETE FROM read_list WHERE user_id = ? AND book_id = ?")
        .run(userId, bookId).changes > 0;
    });
    return removed;
  }

  getPreferences(userId) {
    const stored = this.db.preferences[userId] || {};
    return {
      ...DEFAULT_PREFERENCES,
      ...stored,
      progressDisplay: {
        ...DEFAULT_PREFERENCES.progressDisplay,
        ...(stored.progressDisplay || {})
      }
    };
  }

  async setPreferences(userId, preferences) {
    const current = this.getPreferences(userId);
    this.db.preferences[userId] = {
      ...current,
      ...preferences,
      margin: ["narrow", "medium", "wide"].includes(preferences.margin) ? preferences.margin : current.margin,
      progressDisplay: {
        ...current.progressDisplay,
        ...(preferences.progressDisplay || {})
      },
      fontSize: clampNumber(preferences.fontSize ?? current.fontSize, 70, 220),
      lineHeight: clampNumber(preferences.lineHeight ?? current.lineHeight, 1.1, 2.4),
      skipForwardSeconds: clampSkipSeconds(preferences.skipForwardSeconds ?? current.skipForwardSeconds),
      skipBackSeconds: clampSkipSeconds(preferences.skipBackSeconds ?? current.skipBackSeconds),
      kindleEmail: preferences.kindleEmail === undefined
        ? current.kindleEmail
        : String(preferences.kindleEmail || "").trim().toLowerCase().slice(0, 254)
    };
    await this.save();
    return this.db.preferences[userId];
  }

  getReview(userId, bookId) {
    return this.db.reviews[userId]?.[bookId] || null;
  }

  listBookReviews(bookId) {
    return Object.entries(this.db.reviews)
      .flatMap(([userId, reviews]) => {
        const review = reviews[bookId];
        if (!review) {
          return [];
        }
        const user = this.getPublicUser(userId);
        return [{ ...review, user }];
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async upsertReview(userId, bookId, review) {
    const bucket = ensureNested(this.db.reviews, userId);
    const existing = bucket[bookId] || {};
    const now = new Date().toISOString();
    const next = {
      id: existing.id || nanoid(10),
      userId,
      bookId,
      rating: clampNumber(review.rating ?? existing.rating ?? 0, 0, 5),
      text: String(review.text ?? existing.text ?? "").trim(),
      createdAt: existing.createdAt || now,
      updatedAt: now
    };
    bucket[bookId] = next;
    await this.save();
    return next;
  }

  async deleteReview(userId, bookId) {
    const bucket = ensureNested(this.db.reviews, userId);
    delete bucket[bookId];
    await this.save();
  }

  getCachedDefinition(word) {
    const cached = this.db.dictionaryCache[word];
    if (!cached) {
      return null;
    }

    const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
    if (ageMs > 1000 * 60 * 60 * 24 * 30) {
      return null;
    }
    return cached.result;
  }

  async setCachedDefinition(word, result) {
    this.db.dictionaryCache[word] = {
      result,
      cachedAt: new Date().toISOString()
    };
    await this.save();
  }
}

function configureSqlite(sqlite) {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

function applySchemaMigrations(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrations = [
    {
      version: 1,
      sql: `
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          data_json TEXT NOT NULL
        );
        CREATE TABLE books (
          id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL
        );
        CREATE TABLE progress (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE bookmarks (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE highlights (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE preferences (
          user_id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL
        );
        CREATE TABLE reviews (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE dictionary_cache (
          word TEXT PRIMARY KEY,
          data_json TEXT NOT NULL
        );
        CREATE TABLE mobile_tokens (
          token_hash TEXT PRIMARY KEY,
          data_json TEXT NOT NULL
        );
      `
    },
    {
      version: 2,
      sql: `
        CREATE TABLE server_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          server_id TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL,
          private_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `
    },
    {
      version: 3,
      sql: `
        CREATE TABLE profile_usage (
          user_id TEXT PRIMARY KEY,
          reading_seconds INTEGER NOT NULL DEFAULT 0,
          listening_seconds INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE read_list (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE INDEX read_list_user_added_at_idx
          ON read_list (user_id, added_at DESC);
      `
    },
    {
      version: 4,
      sql: `
        CREATE TABLE control_plane_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          public_key TEXT NOT NULL,
          private_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE platform_accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          email TEXT,
          local_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE registered_servers (
          server_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          public_key TEXT NOT NULL,
          owner_account_id TEXT,
          endpoint_url TEXT,
          endpoint_verified_at TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          claimed_at TEXT,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE server_memberships (
          server_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          local_user_id TEXT,
          role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (server_id, account_id)
        );
        CREATE INDEX server_memberships_account_idx
          ON server_memberships (account_id, updated_at DESC);
        CREATE TABLE server_invitations (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          inviter_account_id TEXT NOT NULL,
          recipient TEXT,
          role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
          library_ids_json TEXT NOT NULL DEFAULT '[]',
          secret_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          accepted_at TEXT,
          accepted_by_account_id TEXT,
          revoked_at TEXT
        );
        CREATE INDEX server_invitations_server_idx
          ON server_invitations (server_id, created_at DESC);
        CREATE TABLE server_claim_codes (
          server_id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE TABLE libraries (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('ebook', 'audiobook', 'mixed')),
          root_path TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by_account_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX libraries_server_idx
          ON libraries (server_id, sort_order, name COLLATE NOCASE);
        CREATE TABLE library_items (
          library_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (library_id, book_id)
        );
        CREATE INDEX library_items_book_idx ON library_items (book_id);
        CREATE TABLE library_access (
          library_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          can_download INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          PRIMARY KEY (library_id, account_id)
        );
        CREATE TABLE account_platform_preferences (
          account_id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
        CREATE TABLE connection_ticket_nonces (
          nonce TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE TABLE friendships (
          requester_account_id TEXT NOT NULL,
          addressee_account_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (requester_account_id, addressee_account_id)
        );
      `
    },
    {
      version: 5,
      sql: `
        CREATE TABLE libby_accounts (
          user_id TEXT PRIMARY KEY,
          identity TEXT NOT NULL,
          linked_at TEXT NOT NULL
        );
      `
    },
    {
      // Libby linking was removed; drop any saved Libby sign-ins.
      version: 6,
      sql: `
        DROP TABLE IF EXISTS libby_accounts;
      `
    }
  ];

  const current = Number(
    sqlite.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version
  );
  for (const migration of migrations) {
    if (migration.version <= current) {
      continue;
    }
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(migration.sql);
      sqlite.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function databaseIsInitialized(sqlite) {
  return Boolean(
    sqlite.prepare("SELECT value FROM metadata WHERE key = 'state_initialized'").get()
  );
}

function normalizeDatabase(existing) {
  return {
    ...clone(EMPTY_DB),
    ...existing,
    books: existing.books || {},
    users: existing.users || {},
    progress: migrateUserBucket(existing.progress),
    bookmarks: migrateUserBucket(existing.bookmarks),
    highlights: migrateUserBucket(existing.highlights),
    preferences: migratePreferences(existing.preferences),
    reviews: migrateUserBucket(existing.reviews),
    dictionaryCache: existing.dictionaryCache || {},
    mobileTokens: existing.mobileTokens || {}
  };
}

function readDatabaseState(sqlite) {
  const state = clone(EMPTY_DB);

  for (const row of sqlite.prepare("SELECT id, data_json FROM books").all()) {
    state.books[row.id] = parseStoredJson(row.data_json, `book ${row.id}`);
  }
  for (const row of sqlite.prepare("SELECT id, data_json FROM users").all()) {
    state.users[row.id] = parseStoredJson(row.data_json, `user ${row.id}`);
  }
  readNestedRows(sqlite, "progress", state.progress);
  readNestedRows(sqlite, "bookmarks", state.bookmarks);
  readNestedRows(sqlite, "highlights", state.highlights);
  readNestedRows(sqlite, "reviews", state.reviews);

  for (const row of sqlite.prepare("SELECT user_id, data_json FROM preferences").all()) {
    state.preferences[row.user_id] = parseStoredJson(row.data_json, `preferences ${row.user_id}`);
  }
  for (const row of sqlite.prepare("SELECT word, data_json FROM dictionary_cache").all()) {
    state.dictionaryCache[row.word] = parseStoredJson(row.data_json, `dictionary ${row.word}`);
  }
  for (const row of sqlite.prepare("SELECT token_hash, data_json FROM mobile_tokens").all()) {
    state.mobileTokens[row.token_hash] = parseStoredJson(row.data_json, "mobile token");
  }

  return state;
}

function readNestedRows(sqlite, table, target) {
  for (const row of sqlite.prepare(`SELECT user_id, book_id, data_json FROM ${table}`).all()) {
    ensureNested(target, row.user_id)[row.book_id] = parseStoredJson(
      row.data_json,
      `${table} ${row.user_id}/${row.book_id}`
    );
  }
}

function writeDatabaseState(sqlite, state, migrationMetadata = null) {
  const insertBook = sqlite.prepare("INSERT INTO books (id, data_json) VALUES (?, ?)");
  const insertUser = sqlite.prepare("INSERT INTO users (id, username, data_json) VALUES (?, ?, ?)");
  const nestedStatements = Object.fromEntries(
    ["progress", "bookmarks", "highlights", "reviews"].map((table) => [
      table,
      sqlite.prepare(`INSERT INTO ${table} (user_id, book_id, data_json) VALUES (?, ?, ?)`)
    ])
  );
  const insertPreferences = sqlite.prepare(
    "INSERT INTO preferences (user_id, data_json) VALUES (?, ?)"
  );
  const insertDictionary = sqlite.prepare(
    "INSERT INTO dictionary_cache (word, data_json) VALUES (?, ?)"
  );
  const insertMobileToken = sqlite.prepare(
    "INSERT INTO mobile_tokens (token_hash, data_json) VALUES (?, ?)"
  );
  const upsertMetadata = sqlite.prepare(
    "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "books",
      "users",
      "progress",
      "bookmarks",
      "highlights",
      "preferences",
      "reviews",
      "dictionary_cache",
      "mobile_tokens"
    ]) {
      sqlite.exec(`DELETE FROM ${table}`);
    }

    for (const [id, book] of Object.entries(state.books || {})) {
      insertBook.run(id, JSON.stringify(book));
    }
    for (const [id, user] of Object.entries(state.users || {})) {
      insertUser.run(id, String(user.username || ""), JSON.stringify(user));
    }
    for (const table of ["progress", "bookmarks", "highlights", "reviews"]) {
      for (const [userId, items] of Object.entries(state[table] || {})) {
        for (const [bookId, value] of Object.entries(items || {})) {
          nestedStatements[table].run(userId, bookId, JSON.stringify(value));
        }
      }
    }
    for (const [userId, value] of Object.entries(state.preferences || {})) {
      insertPreferences.run(userId, JSON.stringify(value));
    }
    for (const [word, value] of Object.entries(state.dictionaryCache || {})) {
      insertDictionary.run(word, JSON.stringify(value));
    }
    for (const [tokenHash, value] of Object.entries(state.mobileTokens || {})) {
      insertMobileToken.run(tokenHash, JSON.stringify(value));
    }

    upsertMetadata.run("state_initialized", "true");
    upsertMetadata.run("last_saved_at", new Date().toISOString());
    if (migrationMetadata) {
      upsertMetadata.run("legacy_source", migrationMetadata.legacySource);
      upsertMetadata.run("legacy_backup", migrationMetadata.legacyBackup);
      upsertMetadata.run("legacy_imported_at", migrationMetadata.importedAt);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function ensureServerIdentity(sqlite) {
  const existing = sqlite.prepare(`
    SELECT server_id, public_key, private_key, created_at
    FROM server_identity
    WHERE singleton = 1
  `).get();
  if (existing) {
    return {
      serverId: existing.server_id,
      publicKey: existing.public_key,
      privateKey: existing.private_key,
      createdAt: existing.created_at
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const identity = {
    serverId: `srv_${nanoid(24)}`,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAt: new Date().toISOString()
  };
  sqlite.prepare(`
    INSERT INTO server_identity (
      singleton, server_id, public_key, private_key, created_at
    ) VALUES (1, ?, ?, ?, ?)
  `).run(identity.serverId, identity.publicKey, identity.privateKey, identity.createdAt);
  return identity;
}

function assertMigrationCounts(expected, actual) {
  const keys = [
    "books",
    "users",
    "progress",
    "bookmarks",
    "highlights",
    "preferences",
    "reviews",
    "dictionaryCache",
    "mobileTokens"
  ];
  for (const key of keys) {
    const expectedCount = countStoredEntries(key, expected[key]);
    const actualCount = countStoredEntries(key, actual[key]);
    if (expectedCount !== actualCount) {
      throw new Error(
        `SQLite migration verification failed for ${key}: expected ${expectedCount}, found ${actualCount}`
      );
    }
  }
}

function countStoredEntries(key, value) {
  if (["progress", "bookmarks", "highlights", "reviews"].includes(key)) {
    return Object.values(value || {}).reduce(
      (total, bucket) => total + Object.keys(bucket || {}).length,
      0
    );
  }
  return Object.keys(value || {}).length;
}

function parseStoredJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid SQLite JSON for ${label}: ${error.message}`);
  }
}

export { SqliteStore as JsonStore };

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function bookSortTitle(book) {
  return String(book.sortTitle || book.title || "");
}

function ensureNested(root, key) {
  if (!root[key] || Array.isArray(root[key])) {
    root[key] = {};
  }
  return root[key];
}

export function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 48);
}

function migrateUserBucket(value) {
  if (!value || Array.isArray(value)) {
    return {};
  }
  return value;
}

function migratePreferences(value) {
  if (!value || Array.isArray(value)) {
    return {};
  }
  if ("fontSize" in value || "fontFamily" in value || "theme" in value) {
    return {};
  }
  return value;
}

// Audiobook skip buttons: whole seconds, 1 second to 10 minutes.
function clampSkipSeconds(value) {
  return Math.round(clampNumber(value, 1, 600));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}
