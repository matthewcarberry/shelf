import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import mime from "mime-types";
import JSZip from "jszip";
import { parseFile } from "music-metadata";

export const DIRECT_FORMATS = new Map([
  [".epub", "epub"],
  [".pdf", "pdf"],
  [".mp3", "audio"],
  [".m4a", "audio"],
  [".m4b", "audio"],
  [".aac", "audio"],
  [".ogg", "audio"],
  [".opus", "audio"],
  [".wav", "audio"],
  [".flac", "audio"]
]);

export const AUDIO_EXTENSIONS = new Set(
  [...DIRECT_FORMATS.entries()]
    .filter(([, format]) => format === "audio")
    .map(([ext]) => ext)
);

export const CONVERTIBLE_EXTENSIONS = new Set([
  ".azw",
  ".azw3",
  ".cb7",
  ".cba",
  ".cbc",
  ".cbr",
  ".cbt",
  ".cbz",
  ".chm",
  ".docx",
  ".fb2",
  ".fbz",
  ".html",
  ".htm",
  ".lit",
  ".lrf",
  ".mobi",
  ".odt",
  ".pdb",
  ".prc",
  ".rb",
  ".rtf",
  ".snb",
  ".tcr",
  ".txt"
]);

export const ALL_BOOK_EXTENSIONS = new Set([
  ...DIRECT_FORMATS.keys(),
  ...CONVERTIBLE_EXTENSIONS
]);

export function getPaths() {
  const root = process.cwd();
  const dataDir = process.env.DATA_DIR || path.join(root, "runtime", "data");
  const libraryDir = process.env.LIBRARY_DIR || path.join(root, "runtime", "library");

  return {
    dataDir,
    libraryDir,
    convertedDir: path.join(dataDir, "converted"),
    coverDir: path.join(dataDir, "covers"),
    dbFile: path.join(dataDir, "shelfstream.json")
  };
}

export async function ensureStorage(paths) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.libraryDir, { recursive: true });
  await fs.mkdir(paths.convertedDir, { recursive: true });
  await fs.mkdir(paths.coverDir, { recursive: true });
}

export async function scanLibrary(store, paths, options = {}) {
  await ensureStorage(paths);
  const ebookFiles = [];
  const audioFiles = [];
  const cachedAudio = buildAudioCache(store.listBooks(), paths.libraryDir);
  const uploadBatchPaths = new Set(
    (options.audioBatchPaths || []).map((value) => normalizePath(value).toLowerCase())
  );

  for await (const filePath of walk(paths.libraryDir)) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ALL_BOOK_EXTENSIONS.has(ext)) {
      continue;
    }
    if (AUDIO_EXTENSIONS.has(ext)) {
      audioFiles.push(filePath);
    } else {
      ebookFiles.push(filePath);
    }
  }

  for (const filePath of ebookFiles) {
    const book = await buildBookRecord(filePath, paths, store);
    await store.upsertBook(book);
  }

  const audioCandidates = [];
  for (const filePath of audioFiles) {
    const stat = await fs.stat(filePath);
    const relPath = normalizePath(path.relative(paths.libraryDir, filePath));
    const cached = cachedAudio.get(relPath.toLowerCase()) || null;
    const cacheMatches = Boolean(cached) &&
      (!Number.isFinite(cached.size) || cached.size === stat.size) &&
      (!Number.isFinite(cached.modifiedMs) || Math.abs(cached.modifiedMs - stat.mtimeMs) < 1);
    audioCandidates.push({
      filePath,
      relPath,
      stat,
      cached,
      cacheMatches,
      uploadBatchKey: uploadBatchPaths.has(relPath.toLowerCase())
        ? options.audioBatchKey || null
        : null
    });
  }

  const directoriesToRefresh = new Set(
    audioCandidates
      .filter((item) => !item.cacheMatches && !item.uploadBatchKey)
      .map((item) => path.posix.dirname(item.relPath).toLowerCase())
  );
  const audioItems = [];
  for (const candidate of audioCandidates) {
    const directory = path.posix.dirname(candidate.relPath).toLowerCase();
    if (candidate.cacheMatches && !directoriesToRefresh.has(directory)) {
      audioItems.push({
        ...cachedAudioItem(candidate),
        uploadBatchKey: candidate.uploadBatchKey
      });
    } else {
      audioItems.push({
        ...await inspectAudioFile(candidate.filePath, paths, candidate.stat),
        uploadBatchKey: candidate.uploadBatchKey
      });
    }
  }

  for (const group of groupAudioFiles(audioItems)) {
    const book = await buildAudiobookRecord(group, paths, store);
    await store.upsertBook(book);
  }

  return store.listBooks();
}

export async function filterDuplicateUploads(files) {
  const accepted = [];
  const duplicates = [];

  for (const file of files || []) {
    const canonicalPath = file.shelfstreamCanonicalPath;
    const uploadedPath = file.path;
    const collidedWithExisting = canonicalPath && uploadedPath &&
      path.resolve(canonicalPath) !== path.resolve(uploadedPath) &&
      fsSync.existsSync(canonicalPath);

    if (collidedWithExisting && await filesAreIdentical(canonicalPath, uploadedPath)) {
      await fs.rm(uploadedPath, { force: true });
      duplicates.push(file.originalname);
      continue;
    }

    accepted.push(file);
  }

  return { files: accepted, duplicates };
}

export function decorateBook(store, book, userId) {
  const progress = userId ? store.getProgress(userId, book.id) : null;
  const safeBook = {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle || null,
    series: book.series || null,
    author: book.author,
    sortTitle: book.sortTitle || null,
    publisher: book.publisher || null,
    publicationDate: book.publicationDate || null,
    language: book.language || null,
    isbnAsin: book.isbnAsin || null,
    description: book.description || null,
    pageCount: book.pageCount || null,
    categories: Array.isArray(book.categories) ? book.categories : [],
    contributors: Array.isArray(book.contributors) ? book.contributors : [],
    narrator: book.mediaType === "audiobook" ? book.narrator || null : null,
    filename: book.filename,
    relPath: book.relPath,
    ext: book.ext,
    size: book.size,
    status: book.status,
    readingFormat: book.readingFormat,
    canConvert: book.canConvert,
    mediaType: book.mediaType || (book.readingFormat === "audio" ? "audiobook" : "ebook"),
    durationSeconds: book.durationSeconds || null,
    trackCount: book.audioFiles?.length || null,
    coverUrl: book.coverPath ? `/api/books/${book.id}/cover?v=${encodeURIComponent(book.updatedAt)}` : null,
    addedAt: book.addedAt,
    updatedAt: book.updatedAt,
    error: book.error || null,
    progress: progress
      ? {
          percent: progress.percent || 0,
          locator: progress.locator || null,
          page: progress.page || null,
          totalPages: progress.totalPages || null,
          updatedAt: progress.updatedAt
        }
      : null
  };

  return safeBook;
}

export function getReadingFile(book) {
  if (book.readingFormat === "audio") {
    const firstTrack = book.audioFiles?.[0];
    return firstTrack ? { filePath: firstTrack.path, format: "audio" } : null;
  }

  if (book.readingFormat === "epub" && book.convertedPath) {
    return { filePath: book.convertedPath, format: "epub" };
  }

  if (DIRECT_FORMATS.has(book.ext)) {
    return { filePath: book.path, format: DIRECT_FORMATS.get(book.ext) };
  }

  return null;
}

export function getAudioTracks(book) {
  if (book.readingFormat !== "audio") {
    return [];
  }

  return (book.audioFiles || []).map((track, index) => ({
    index,
    title: track.title || `Part ${index + 1}`,
    filename: track.filename,
    durationSeconds: track.durationSeconds || null
  }));
}

export async function convertBook(store, paths, bookId) {
  const book = store.getBook(bookId);
  if (!book) {
    throw new Error("Book not found");
  }

  if (!book.canConvert) {
    throw new Error("This file type is not convertible");
  }

  const output = path.join(paths.convertedDir, `${book.id}.epub`);
  if (fsSync.existsSync(output)) {
    return store.patchBook(book.id, {
      convertedPath: output,
      readingFormat: "epub",
      status: "ready",
      error: null
    });
  }

  await store.patchBook(book.id, {
    status: "converting",
    error: null
  });

  try {
    await runProcess("ebook-convert", [
      book.path,
      output,
      "--enable-heuristics",
      "--embed-all-fonts"
    ]);

    return store.patchBook(book.id, {
      convertedPath: output,
      readingFormat: "epub",
      status: "ready",
      error: null
    });
  } catch (error) {
    await fs.rm(output, { force: true }).catch(() => {});
    const message =
      error && typeof error.message === "string"
        ? error.message
        : "Conversion failed";

    await store.patchBook(book.id, {
      status: "error",
      error: message
    });
    throw error;
  }
}

export function streamFile(req, res, filePath, fallbackType) {
  if (!filePath || !fsSync.existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const stat = fsSync.statSync(filePath);
  const total = stat.size;
  const type = mime.lookup(filePath) || fallbackType || "application/octet-stream";
  const filename = path.basename(filePath).replaceAll('"', "");

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, max-age=60");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", total);
    fsSync.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).end();
    return;
  }

  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffixLength = Number.parseInt(match[2], 10);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = match[1] ? Number.parseInt(match[1], 10) : 0;
    end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
  }

  if (start >= total || end >= total || start > end) {
    res.writeHead(416, {
      "Content-Range": `bytes */${total}`
    });
    res.end();
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": type,
    "Content-Disposition": `inline; filename="${filename}"`
  });
  fsSync.createReadStream(filePath, { start, end }).pipe(res);
}

async function buildBookRecord(filePath, paths, store) {
  const stat = await fs.stat(filePath);
  const relPath = normalizePath(path.relative(paths.libraryDir, filePath));
  const ext = path.extname(filePath).toLowerCase();
  const id = crypto.createHash("sha1").update(relPath.toLowerCase()).digest("hex").slice(0, 16);
  const existing = store.getBook(id) || {};
  const fallbackTitle = titleFromFilename(path.basename(filePath, ext));
  const filenameMetadata = metadataFromFilename(path.basename(filePath, ext));
  const embeddedMetadata = await readBookMetadata(filePath).catch(() => null);
  const convertedPath = existing.convertedPath || path.join(paths.convertedDir, `${id}.epub`);
  const convertedExists = fsSync.existsSync(convertedPath);
  const directFormat = DIRECT_FORMATS.get(ext);
  const canConvert = CONVERTIBLE_EXTENSIONS.has(ext);
  const readingFormat = directFormat || (convertedExists ? "epub" : null);
  const status = directFormat || convertedExists ? "ready" : canConvert ? "needs-conversion" : "unsupported";
  const cover = await ensureCover(filePath, id, paths, existing);
  const titleWasGenerated = !existing.title || existing.title === fallbackTitle;
  const authorWasUnknown = !existing.author || existing.author === "Unknown author";

  return {
    id,
    title: titleWasGenerated
      ? embeddedMetadata?.title || filenameMetadata.title || fallbackTitle
      : existing.title,
    author: authorWasUnknown
      ? embeddedMetadata?.author || filenameMetadata.author || "Unknown author"
      : existing.author,
    filename: path.basename(filePath),
    relPath,
    path: filePath,
    ext,
    size: stat.size,
    status,
    readingFormat,
    mediaType: "ebook",
    canConvert,
    coverPath: cover?.path || existing.coverPath || null,
    coverMime: cover?.mime || existing.coverMime || null,
    convertedPath: convertedExists ? convertedPath : existing.convertedPath || null,
    error: status === "needs-conversion" ? null : existing.error || null,
    addedAt: existing.addedAt || stat.birthtime.toISOString()
  };
}

async function inspectAudioFile(filePath, paths, suppliedStat = null) {
  const stat = suppliedStat || await fs.stat(filePath);
  const relPath = normalizePath(path.relative(paths.libraryDir, filePath));
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);
  const metadata = await parseFile(filePath, { duration: true }).catch(() => null);
  const fallbackTitle = audioTitleFromFilename(path.basename(filePath, ext));
  return {
    path: filePath,
    relPath,
    filename,
    ext,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    birthtime: stat.birthtime,
    title: cleanMetadataValue(metadata?.common?.title) || fallbackTitle,
    album: cleanMetadataValue(metadata?.common?.album),
    artist:
      cleanMetadataValue(metadata?.common?.albumartist) ||
      cleanMetadataValue(metadata?.common?.artist) ||
      "Unknown author",
    durationSeconds: finitePositive(metadata?.format?.duration),
    disc: finitePositive(metadata?.common?.disk?.no) || audioDiscFromFilename(filename),
    track: finitePositive(metadata?.common?.track?.no),
    picture: metadata?.common?.picture?.[0] || null
  };
}

function groupAudioFiles(items) {
  const groups = new Map();
  for (const item of items) {
    const directory = path.posix.dirname(item.relPath);
    const albumKey = item.album
        ? `album:${item.artist.toLowerCase()}:${item.album.toLowerCase()}`
        : item.uploadBatchKey
          ? `batch:${item.uploadBatchKey}`
          : item.existingBookId
            ? `existing:${item.existingBookId}`
        : directory && directory !== "."
          ? `directory:${directory.toLowerCase()}`
          : `file:${item.relPath.toLowerCase()}`;
    if (!groups.has(albumKey)) {
      groups.set(albumKey, []);
    }
    groups.get(albumKey).push(item);
  }

  return [...groups.entries()].map(([key, tracks]) => ({
    key,
    existingBookId: tracks.every((track) => track.existingBookId === tracks[0]?.existingBookId)
      ? tracks[0]?.existingBookId || null
      : null,
    tracks: tracks.sort(compareAudioTracks)
  }));
}

async function buildAudiobookRecord(group, paths, store) {
  const id = group.existingBookId || crypto.createHash("sha1").update(`audio:${group.key}`).digest("hex").slice(0, 16);
  const existing = store.getBook(id) || {};
  const first = group.tracks[0];
  const directory = path.posix.dirname(first.relPath);
  const directoryTitle = directory && directory !== "." ? titleFromFilename(path.posix.basename(directory)) : "";
  const inferredMetadata = inferAudiobookMetadata(group.tracks);
  const generatedTitle = first.album ||
    (group.tracks.length > 1 ? directoryTitle || inferredMetadata.title : first.title) ||
    first.title;
  const cover = await ensureAudioCover(group.tracks, id, paths, existing);
  const knownDurations = group.tracks.map((track) => track.durationSeconds).filter(Boolean);
  const durationSeconds = knownDurations.length === group.tracks.length
    ? knownDurations.reduce((total, value) => total + value, 0)
    : null;

  return {
    id,
    title: existing.title || generatedTitle || "Untitled audiobook",
    author: existing.author && existing.author !== "Unknown author"
      ? existing.author
      : first.artist !== "Unknown author"
        ? first.artist
        : inferredMetadata.author || first.artist,
    filename: first.filename,
    relPath: first.relPath,
    path: first.path,
    ext: first.ext,
    size: group.tracks.reduce((total, track) => total + track.size, 0),
    status: "ready",
    readingFormat: "audio",
    mediaType: "audiobook",
    canConvert: false,
    coverPath: cover?.path || existing.coverPath || null,
    coverMime: cover?.mime || existing.coverMime || null,
    convertedPath: null,
    durationSeconds,
    audioFiles: group.tracks.map((track) => ({
      path: track.path,
      relPath: track.relPath,
      filename: track.filename,
      title: track.title,
      durationSeconds: track.durationSeconds,
      album: track.album,
      artist: track.artist,
      disc: track.disc,
      track: track.track,
      size: track.size,
      modifiedMs: track.modifiedMs
    })),
    error: null,
    addedAt: existing.addedAt || new Date(Math.min(...group.tracks.map((track) => track.birthtime.getTime()))).toISOString()
  };
}

function inferAudiobookMetadata(tracks) {
  if (!tracks.length) return { title: "", author: "" };
  const cleaned = tracks.map((track) => audiobookStemFromFilename(track.filename));
  const first = cleaned[0] || "";
  const shared = cleaned.every((value) => value.toLowerCase() === first.toLowerCase()) ? first : "";
  if (!shared) return { title: "", author: "" };

  const parts = shared.split(/\s+-\s+/);
  if (parts.length < 2) return { title: shared, author: "" };
  return {
    author: parts[0].trim(),
    title: parts.slice(1).join(" - ").trim()
  };
}

function audiobookStemFromFilename(filename) {
  const ext = path.extname(filename);
  return titleFromFilename(path.basename(filename, ext))
    .replace(/\s+(?:part|disc|disk|cd)\s*\d+\s+\d+(?:-\d+)?$/i, "")
    .replace(/\s+(?:chapter|track)\s*\d+(?:-\d+)?$/i, "")
    .replace(/\s+\d+(?:-\d+)?$/i, "")
    .trim();
}

function audioDiscFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const match = stem.match(/(?:^|[\s._-])(?:part|disc|disk|cd)\s*[-_.]?\s*(\d+)(?:$|[\s._-])/i);
  return finitePositive(match?.[1]);
}

async function ensureAudioCover(tracks, bookId, paths, existing) {
  if (existing.coverPath && fsSync.existsSync(existing.coverPath)) {
    return { path: existing.coverPath, mime: existing.coverMime || mime.lookup(existing.coverPath) || "image/jpeg" };
  }

  const picture = tracks.find((track) => track.picture)?.picture;
  if (picture?.data) {
    const pictureMime = picture.format || "image/jpeg";
    const output = path.join(paths.coverDir, `${bookId}-cover${extensionForMime(pictureMime) || ".jpg"}`);
    await fs.writeFile(output, picture.data);
    return { path: output, mime: pictureMime };
  }

  const firstPath = tracks[0]?.path;
  const directory = firstPath ? path.dirname(firstPath) : null;
  if (!directory) {
    return null;
  }

  const stem = path.basename(firstPath, path.extname(firstPath));
  const candidates = [stem, "cover", "folder", "front"];
  for (const name of candidates) {
    for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
      const candidate = path.join(directory, `${name}${ext}`);
      if (fsSync.existsSync(candidate)) {
        return { path: candidate, mime: mime.lookup(candidate) || "image/jpeg" };
      }
    }
  }
  return null;
}

function compareAudioTracks(a, b) {
  return (a.cachedOrder ?? Number.MAX_SAFE_INTEGER) - (b.cachedOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.disc || 0) - (b.disc || 0) ||
    (a.track || 0) - (b.track || 0) ||
    a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" });
}

function buildAudioCache(books, libraryRoot) {
  const cache = new Map();
  for (const book of books) {
    if (book.mediaType !== "audiobook" && book.readingFormat !== "audio") continue;
    for (const [index, track] of (book.audioFiles || []).entries()) {
      const relPath = normalizePath(
        track.relPath || (track.path ? path.relative(libraryRoot, track.path) : "")
      );
      if (!relPath) continue;
      cache.set(relPath.toLowerCase(), {
        existingBookId: book.id,
        cachedOrder: index,
        title: track.title,
        album: track.album || null,
        artist: track.artist || book.author,
        disc: finitePositive(track.disc),
        track: finitePositive(track.track),
        durationSeconds: track.durationSeconds,
        size: Number.isFinite(track.size) ? track.size : null,
        modifiedMs: Number.isFinite(track.modifiedMs) ? track.modifiedMs : null
      });
    }
  }
  return cache;
}

function cachedAudioItem({ filePath, relPath, stat, cached }) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    path: filePath,
    relPath,
    filename: path.basename(filePath),
    ext,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    birthtime: stat.birthtime,
    title: cached.title || audioTitleFromFilename(path.basename(filePath, ext)),
    album: cached.album || null,
    artist: cached.artist || "Unknown author",
    durationSeconds: finitePositive(cached.durationSeconds),
    disc: finitePositive(cached.disc),
    track: finitePositive(cached.track),
    picture: null,
    existingBookId: cached.existingBookId,
    cachedOrder: cached.cachedOrder
  };
}

async function filesAreIdentical(firstPath, secondPath) {
  const [firstStat, secondStat] = await Promise.all([fs.stat(firstPath), fs.stat(secondPath)]);
  if (firstStat.size !== secondStat.size) return false;
  const [firstHash, secondHash] = await Promise.all([hashFile(firstPath), hashFile(secondPath)]);
  return firstHash === secondHash;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function cleanMetadataValue(value) {
  return String(value || "").trim();
}

function audioTitleFromFilename(value) {
  return titleFromFilename(value)
    .replace(/^\s*(?:disc|disk|part|chapter|track)?\s*\d+\s*[-:–—)]\s*/i, "")
    .trim() || titleFromFilename(value);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function ensureCover(filePath, bookId, paths, existing) {
  if (existing.coverPath && fsSync.existsSync(existing.coverPath)) {
    return {
      path: existing.coverPath,
      mime: existing.coverMime || mime.lookup(existing.coverPath) || "image/jpeg"
    };
  }

  const calibreCover = await extractCoverWithCalibre(filePath, bookId, paths).catch(() => null);
  if (calibreCover) {
    return calibreCover;
  }

  if (path.extname(filePath).toLowerCase() === ".epub") {
    return extractEpubCover(filePath, bookId, paths).catch(() => null);
  }

  return null;
}

async function extractCoverWithCalibre(filePath, bookId, paths) {
  const output = path.join(paths.coverDir, `${bookId}-cover.jpg`);
  await fs.rm(output, { force: true }).catch(() => {});
  await runProcess("ebook-meta", [filePath, `--get-cover=${output}`]);
  if (!fsSync.existsSync(output) || fsSync.statSync(output).size === 0) {
    await fs.rm(output, { force: true }).catch(() => {});
    return null;
  }
  return { path: output, mime: "image/jpeg" };
}

async function extractEpubCover(filePath, bookId, paths) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = getXmlAttribute(containerXml, "rootfile", "full-path");
  if (!opfPath) {
    return null;
  }

  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) {
    return null;
  }

  const coverId =
    getMetaContent(opf, "cover") ||
    getManifestCoverId(opf);
  const coverHref = coverId ? getManifestItemHref(opf, coverId) : null;
  if (!coverHref) {
    return null;
  }

  const coverPath = normalizePath(path.posix.join(path.posix.dirname(opfPath), normalizeEpubHref(coverHref)));
  const coverFile = zip.file(coverPath);
  if (!coverFile) {
    return null;
  }

  const coverMime = mime.lookup(coverPath) || "image/jpeg";
  const outputExt = extensionForMime(coverMime) || path.extname(coverPath) || ".jpg";
  const output = path.join(paths.coverDir, `${bookId}-cover${outputExt}`);
  await fs.writeFile(output, await coverFile.async("nodebuffer"));
  return { path: output, mime: coverMime };
}

function getXmlAttribute(xml, tagName, attributeName) {
  if (!xml) {
    return null;
  }
  const tagMatch = new RegExp(`<[^>]*${tagName}\\b[^>]*>`, "i").exec(xml);
  return tagMatch ? getAttributeFromTag(tagMatch[0], attributeName) : null;
}

function getMetaContent(opf, name) {
  const metaTags = opf.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (getAttributeFromTag(tag, "name")?.toLowerCase() === name) {
      return getAttributeFromTag(tag, "content");
    }
  }
  return null;
}

function getManifestCoverId(opf) {
  const itemTags = opf.match(/<item\b[^>]*>/gi) || [];
  for (const tag of itemTags) {
    const properties = getAttributeFromTag(tag, "properties") || "";
    if (properties.split(/\s+/).includes("cover-image")) {
      return getAttributeFromTag(tag, "id");
    }
  }
  return null;
}

function getManifestItemHref(opf, itemId) {
  const itemTags = opf.match(/<item\b[^>]*>/gi) || [];
  for (const tag of itemTags) {
    if (getAttributeFromTag(tag, "id") === itemId) {
      return getAttributeFromTag(tag, "href");
    }
  }
  return null;
}

function getAttributeFromTag(tag, attributeName) {
  const match = new RegExp(`${attributeName}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeEpubHref(value) {
  const withoutFragment = String(value || "").split("#")[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function extensionForMime(value) {
  const ext = mime.extension(value);
  return ext ? `.${ext}` : "";
}

async function* walk(dir) {
  if (!fsSync.existsSync(dir)) {
    return;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function titleFromFilename(name) {
  return name.replaceAll("_", " ").replaceAll(".", " ").replace(/\s+/g, " ").trim();
}

function metadataFromFilename(name) {
  const normalized = titleFromFilename(name);
  const parts = normalized.split(/\s+-\s+/);
  if (parts.length < 2) {
    return { title: normalized, author: "" };
  }

  return {
    title: parts.slice(0, -1).join(" - ").trim(),
    author: parts[parts.length - 1].trim()
  };
}

async function readBookMetadata(filePath) {
  const output = await runProcessCapture("ebook-meta", [filePath]);
  const title = parseMetadataLine(output, "Title");
  const author = parseMetadataLine(output, "Author(s)");
  return {
    title: title || "",
    author: author.replace(/\s*\[.*?\]\s*$/, "").trim()
  };
}

function parseMetadataLine(output, label) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.toLowerCase().startsWith(label.toLowerCase()));
  if (!line) {
    return "";
  }
  return line.replace(/^[^:]+:\s*/, "").trim();
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("Calibre ebook-convert is not installed in this environment"));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ebook-convert exited with code ${code}`));
    });
  });
}

function runProcessCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}
