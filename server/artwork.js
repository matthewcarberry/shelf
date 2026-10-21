import dns from "node:dns/promises";
import net from "node:net";

const OPEN_LIBRARY_ORIGIN = "https://openlibrary.org";
const OPEN_LIBRARY_COVERS_ORIGIN = "https://covers.openlibrary.org";
const USER_AGENT = "Shelf/0.1 (+https://shelf-stream.com)";
const MAX_RESULTS = 24;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export async function searchOpenLibraryArtwork(input, fetchImpl = fetch) {
  const title = cleanSearchValue(input?.title, 240);
  const author = normalizeAuthor(cleanSearchValue(input?.author, 180));
  if (!title) {
    const error = new Error("A title is required to search for artwork");
    error.status = 400;
    throw error;
  }

  let documents = await searchWorks({ title, author }, fetchImpl);
  if (!documents.length && author) {
    documents = await searchWorks({ title, author: "" }, fetchImpl);
  }

  const ranked = documents
    .map((document) => ({ document, score: scoreWork(document, title, author) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const editions = await Promise.all(
    ranked.slice(0, 2).map(({ document }) => fetchIsbnEditions(document?.isbn, fetchImpl))
  );

  const candidates = [];
  const seen = new Set();
  for (const [index, { document }] of ranked.entries()) {
    addCandidate(candidates, seen, {
      coverId: document?.cover_i,
      title: document?.title || title,
      author: firstValue(document?.author_name) || author,
      year: finiteYear(document?.first_publish_year),
      publisher: "",
      sourcePath: document?.key || ""
    });

    for (const edition of editions[index] || []) {
      addCandidate(candidates, seen, {
        coverId: edition.coverId,
        title: edition.title || document?.title || title,
        author: edition.author || firstValue(document?.author_name) || author,
        year: yearFromDate(edition.publishDate) || finiteYear(document?.first_publish_year),
        publisher: edition.publisher,
        sourceUrl: edition.sourceUrl,
        sourcePath: document?.key || ""
      });
    }
  }

  return candidates.slice(0, MAX_RESULTS);
}

export async function downloadOpenLibraryCover(coverId, fetchImpl = fetch) {
  const normalizedCoverId = normalizeCoverId(coverId);
  if (!normalizedCoverId) {
    const error = new Error("Invalid artwork selection");
    error.status = 400;
    throw error;
  }

  const url = `${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/${normalizedCoverId}-L.jpg?default=false`;
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) {
    const error = new Error(response.status === 404
      ? "That artwork is no longer available"
      : "Unable to download artwork from Open Library");
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    const error = new Error("Artwork exceeds the 10 MB size limit");
    error.status = 413;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    const error = new Error(buffer.length ? "Artwork exceeds the 10 MB size limit" : "Artwork download was empty");
    error.status = buffer.length ? 413 : 502;
    throw error;
  }

  const detected = detectImageType(buffer);
  if (!detected) {
    const error = new Error("Open Library returned an unsupported artwork file");
    error.status = 502;
    throw error;
  }

  return { ...detected, buffer, coverId: normalizedCoverId };
}

export async function downloadArtworkFromUrl(value, { fetchImpl = fetch, lookupImpl = dns.lookup } = {}) {
  let url = parseArtworkUrl(value);
  for (let redirects = 0; ; redirects += 1) {
    await assertPublicHost(url.hostname, lookupImpl);
    const response = await fetchImpl(url, {
      headers: { Accept: "image/*", "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000)
    }).catch((cause) => {
      throw httpError("That image URL could not be reached", 502, cause);
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (redirects >= MAX_REDIRECTS) throw httpError("That image URL redirects too many times", 502);
      url = parseArtworkUrl(new URL(response.headers.get("location"), url).toString());
      continue;
    }
    if (!response.ok) {
      throw httpError(`That image URL returned an error (HTTP ${response.status})`, 502);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw httpError("Artwork exceeds the 10 MB size limit", 413);
    const buffer = await readLimited(response);
    if (!buffer.length) throw httpError("That image URL returned an empty file", 502);

    const detected = detectImageType(buffer);
    if (!detected) throw httpError("That URL is not a JPEG, PNG, or WebP image", 415);
    return { ...detected, buffer };
  }
}

function parseArtworkUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw httpError("Enter a valid image URL", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw httpError("Image URLs must start with http:// or https://", 400);
  }
  if (url.username || url.password) throw httpError("Image URLs can't include a username or password", 400);
  return url;
}

// The server fetches the URL itself, so keep it from being pointed at the LAN or the container.
async function assertPublicHost(hostname, lookupImpl) {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    throw httpError("That image URL's server could not be found", 400);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw httpError("Image URLs must point to a public website", 400);
  }
}

function isPrivateAddress(address) {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const value = mapped ? mapped[1] : address.toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  return value === "::" || value === "::1" || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value);
}

async function readLimited(response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) throw httpError("Artwork exceeds the 10 MB size limit", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function httpError(message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  return error;
}

async function searchWorks({ title, author }, fetchImpl) {
  const url = new URL(`${OPEN_LIBRARY_ORIGIN}/search.json`);
  url.searchParams.set("title", title);
  if (author) url.searchParams.set("author", author);
  url.searchParams.set("fields", "key,title,author_name,cover_i,first_publish_year,isbn");
  url.searchParams.set("limit", "8");
  const payload = await fetchJson(url, fetchImpl);
  return Array.isArray(payload?.docs) ? payload.docs : [];
}

async function fetchIsbnEditions(values, fetchImpl) {
  const isbns = [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeIsbn)
    .filter(Boolean))]
    .slice(0, 40);
  if (!isbns.length) return [];
  const url = new URL(`${OPEN_LIBRARY_ORIGIN}/api/books`);
  url.searchParams.set("bibkeys", isbns.map((isbn) => `ISBN:${isbn}`).join(","));
  url.searchParams.set("jscmd", "data");
  url.searchParams.set("format", "json");
  try {
    const payload = await fetchJson(url, fetchImpl);
    return Object.values(payload || {}).flatMap((edition) => {
      const coverId = coverIdFromUrl(edition?.cover?.large || edition?.cover?.medium);
      if (!coverId) return [];
      return [{
        coverId,
        title: edition?.title || "",
        author: firstNamedValue(edition?.authors),
        publisher: firstNamedValue(edition?.publishers),
        publishDate: edition?.publish_date || "",
        sourceUrl: safeOpenLibraryUrl(edition?.url)
      }];
    });
  } catch {
    return [];
  }
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) {
    const error = new Error("Artwork search is temporarily unavailable");
    error.status = 502;
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error("Artwork provider returned an invalid response");
    error.status = 502;
    throw error;
  }
}

function fetchWithTimeout(fetchImpl, url) {
  return fetchImpl(url, {
    headers: { Accept: "application/json, image/*", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000)
  }).catch((cause) => {
    const error = new Error("Artwork provider could not be reached", { cause });
    error.status = 502;
    throw error;
  });
}

function addCandidate(candidates, seen, candidate) {
  const coverId = normalizeCoverId(candidate.coverId);
  if (!coverId || seen.has(coverId) || candidates.length >= MAX_RESULTS) return;
  seen.add(coverId);
  const sourcePath = /^\/(works|books)\/OL[\dA-Z]+$/i.test(candidate.sourcePath)
    ? candidate.sourcePath
    : "";
  candidates.push({
    id: `openlibrary:${coverId}`,
    coverId,
    title: cleanSearchValue(candidate.title, 240),
    author: cleanSearchValue(candidate.author, 180),
    year: finiteYear(candidate.year),
    publisher: cleanSearchValue(candidate.publisher, 180),
    thumbnailUrl: `${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/${coverId}-M.jpg?default=false`,
    imageUrl: `${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/${coverId}-L.jpg?default=false`,
    source: "Open Library",
    sourceUrl: safeOpenLibraryUrl(candidate.sourceUrl) || (sourcePath ? `${OPEN_LIBRARY_ORIGIN}${sourcePath}` : OPEN_LIBRARY_ORIGIN)
  });
}

function scoreWork(document, title, author) {
  const candidateTitle = normalizeText(document?.title);
  const requestedTitle = normalizeText(title);
  const candidateAuthors = (document?.author_name || []).map(normalizeText);
  const requestedAuthor = normalizeText(author);
  let score = candidateTitle === requestedTitle ? 100 : candidateTitle.includes(requestedTitle) ? 60 : 0;
  if (requestedAuthor && candidateAuthors.some((value) => value === requestedAuthor)) score += 50;
  else if (requestedAuthor && candidateAuthors.some((value) => value.includes(requestedAuthor) || requestedAuthor.includes(value))) score += 25;
  if (normalizeCoverId(document?.cover_i)) score += 10;
  return score;
}

function normalizeAuthor(value) {
  const author = cleanSearchValue(value, 180);
  if (!author || /^unknown author$/i.test(author)) return "";
  const parts = author.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : author;
}

function normalizeCoverId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIsbn(value) {
  const isbn = String(value || "").replace(/[^\dX]/gi, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(isbn) ? isbn : "";
}

function coverIdFromUrl(value) {
  const match = String(value || "").match(/\/b\/id\/(\d+)-(?:[SML])\.jpg/i);
  return normalizeCoverId(match?.[1]);
}

function safeOpenLibraryUrl(value) {
  try {
    const url = new URL(String(value || ""), OPEN_LIBRARY_ORIGIN);
    return url.hostname === "openlibrary.org" ? `https://openlibrary.org${url.pathname}${url.search}` : "";
  } catch {
    return "";
  }
}

export function detectImageType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", extension: ".jpg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: ".png" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", extension: ".webp" };
  }
  return null;
}

function cleanSearchValue(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeText(value) {
  return cleanSearchValue(value, 240).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function finiteYear(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1000 && parsed <= 9999 ? parsed : null;
}

function yearFromDate(value) {
  const match = String(value || "").match(/\b(\d{4})\b/);
  return finiteYear(match?.[1]);
}

function firstValue(value) {
  return Array.isArray(value) ? value.find((item) => cleanSearchValue(item, 240)) || "" : "";
}

function firstNamedValue(value) {
  if (!Array.isArray(value)) return "";
  return cleanSearchValue(value.find((item) => cleanSearchValue(item?.name, 240))?.name, 240);
}
