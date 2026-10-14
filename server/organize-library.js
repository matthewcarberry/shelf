// Moves every book into <library>/<ebooks|audiobooks>/<Title (Year)>/ and keeps each book's ID,
// so reading progress, bookmarks and highlights stay attached.
// Stop Shelf before running this: the server keeps the database in memory and would overwrite the changes.
//
// Usage: node server/organize-library.js [--dry-run] [--years <file.json>] [--exclude <relative path prefix>]...
//   --years    JSON object of { "<book id>": <year> } used to fill in publication years first.
//   --exclude  Leave books whose relative path starts with this prefix where they are.
import fs from "node:fs/promises";
import path from "node:path";
import { getPaths, organizeBook, organizedBookDir } from "./library.js";
import { SqliteStore } from "./store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const excludes = [];
let yearsFile = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--exclude") excludes.push(args[++index].toLowerCase());
  if (args[index] === "--years") yearsFile = args[++index];
}

const paths = getPaths();
const store = new SqliteStore(paths.dbFile);
await store.init();

let failures = 0;
let movedFiles = 0;
try {
  const years = yearsFile ? JSON.parse(await fs.readFile(yearsFile, "utf8")) : {};
  for (const [bookId, year] of Object.entries(years)) {
    if (!store.getBook(bookId)) {
      console.warn(`Skipping year for unknown book ${bookId}`);
    } else if (!dryRun) {
      await store.patchBook(bookId, { publicationDate: String(year) });
    }
  }

  for (const stored of store.listBooks()) {
    const book = dryRun && years[stored.id]
      ? { ...stored, publicationDate: String(years[stored.id]) }
      : stored;
    const relPath = String(book.relPath || "").toLowerCase();
    if (excludes.some((prefix) => relPath.startsWith(prefix))) {
      console.log(`skip   ${book.title} (${book.relPath})`);
      continue;
    }

    try {
      const { moves } = await organizeBook(store, paths, book, { dryRun });
      const target = path.relative(paths.libraryDir, organizedBookDir(paths, book));
      console.log(`${moves.length ? (dryRun ? "would" : "moved") : "ok    "} ${book.title} -> ${target} (${moves.length} files)`);
      movedFiles += moves.length;
    } catch (error) {
      failures += 1;
      console.error(`failed ${book.title}: ${error.message}`);
    }
  }
} finally {
  await store.writeQueue;
  store.close();
}

console.log(`${dryRun ? "Would move" : "Moved"} ${movedFiles} files; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
