import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "../server/store.js";

const source = process.argv[2];
if (!source) {
  throw new Error("Usage: node scripts/verify-storage-migration.js <shelfstream.json>");
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-live-migration-"));
const legacyFile = path.join(workspace, "shelfstream.json");

try {
  await fs.copyFile(path.resolve(source), legacyFile);
  const store = new SqliteStore(legacyFile);
  await store.init();
  try {
    const nestedCount = (bucket) => Object.values(bucket || {}).reduce(
      (total, value) => total + Object.keys(value || {}).length,
      0
    );
    const result = {
      users: store.listUsers().length,
      books: store.listBooks().length,
      progress: nestedCount(store.db.progress),
      bookmarks: nestedCount(store.db.bookmarks),
      highlights: nestedCount(store.db.highlights),
      preferences: Object.keys(store.db.preferences).length,
      reviews: nestedCount(store.db.reviews),
      mobileTokens: Object.keys(store.db.mobileTokens).length,
      serverId: store.getPublicServerIdentity().serverId,
      backupCreated: await exists(`${legacyFile}.pre-sqlite-backup`)
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
} finally {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (!resolvedWorkspace.startsWith(`${resolvedTemp}${path.sep}`)) {
    throw new Error("Refusing to remove a migration workspace outside the system temp directory");
  }
  await fs.rm(resolvedWorkspace, { recursive: true, force: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
