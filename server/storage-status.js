import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const databaseFile = path.join(dataDir, "shelfstream.sqlite");
const database = new DatabaseSync(databaseFile, { readOnly: true });

function count(table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

try {
  const identity = database
    .prepare("SELECT server_id AS serverId FROM server_identity WHERE singleton = 1")
    .get();
  const migration = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS schemaVersion FROM schema_migrations")
    .get();
  const integrity = database.prepare("PRAGMA integrity_check").get();

  const status = {
    users: count("users"),
    books: count("books"),
    progress: count("progress"),
    bookmarks: count("bookmarks"),
    highlights: count("highlights"),
    preferences: count("preferences"),
    reviews: count("reviews"),
    mobileTokens: count("mobile_tokens"),
    schemaVersion: Number(migration.schemaVersion),
    serverId: identity.serverId,
    integrity: integrity.integrity_check
  };

  if (process.env.EXPECTED_STORAGE_COUNTS) {
    const expected = JSON.parse(process.env.EXPECTED_STORAGE_COUNTS);
    for (const [key, value] of Object.entries(expected)) {
      if (status[key] !== value) {
        throw new Error(`Storage verification failed for ${key}: expected ${value}, received ${status[key]}`);
      }
    }
  }

  console.log(JSON.stringify(status));
} finally {
  database.close();
}
