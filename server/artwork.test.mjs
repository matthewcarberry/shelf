import assert from "node:assert/strict";
import test from "node:test";
import { downloadArtworkFromUrl, downloadOpenLibraryCover, searchOpenLibraryArtwork } from "./artwork.js";

test("finds and deduplicates Open Library covers across matching editions", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.includes("/search.json")) {
      return Response.json({ docs: [
        { key: "/works/OL1W", title: "The Handmaid's Tale", author_name: ["Margaret Atwood"], cover_i: 100, first_publish_year: 1985, isbn: ["9780385490818"] },
        { key: "/works/OL2W", title: "The Handmaid's Tale", author_name: ["Margaret Atwood"], cover_i: 200, first_publish_year: 1986, isbn: ["9780771008139"] }
      ] });
    }
    if (value.includes("/api/books") && value.includes("9780385490818")) {
      return Response.json({
        "ISBN:9780385490818": {
          title: "The Handmaid's Tale",
          authors: [{ name: "Margaret Atwood" }],
          publishers: [{ name: "McClelland & Stewart" }],
          publish_date: "1985",
          cover: { large: "https://covers.openlibrary.org/b/id/101-L.jpg" },
          url: "http://openlibrary.org/books/OL10M/The_Handmaids_Tale"
        }
      });
    }
    if (value.includes("/api/books") && value.includes("9780771008139")) {
      return Response.json({
        "ISBN:9780771008139": {
          title: "The Handmaid's Tale",
          cover: { large: "https://covers.openlibrary.org/b/id/201-L.jpg" },
          url: "https://openlibrary.org/books/OL20M/The_Handmaids_Tale"
        }
      });
    }
    throw new Error(`Unexpected request ${value}`);
  };

  const results = await searchOpenLibraryArtwork({
    title: "The Handmaid's Tale",
    author: "Atwood, Margaret"
  }, fetchImpl);

  assert.deepEqual(results.map((result) => result.coverId), [100, 101, 200, 201]);
  assert.equal(results[1].publisher, "McClelland & Stewart");
  assert.equal(results[1].sourceUrl, "https://openlibrary.org/books/OL10M/The_Handmaids_Tale");
  const searchUrl = new URL(requested.find((value) => value.includes("/search.json")));
  assert.equal(searchUrl.searchParams.get("author"), "Margaret Atwood");
});

test("downloads and validates a selected Open Library cover", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  const result = await downloadOpenLibraryCover(123, async (url) => {
    assert.equal(String(url), "https://covers.openlibrary.org/b/id/123-L.jpg?default=false");
    return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  });

  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.extension, ".jpg");
  assert.deepEqual(result.buffer, jpeg);
});

test("rejects invalid artwork selections and non-image responses", async () => {
  await assert.rejects(
    downloadOpenLibraryCover("not-a-number", async () => new Response()),
    /Invalid artwork selection/
  );
  await assert.rejects(
    downloadOpenLibraryCover(123, async () => new Response("not an image", { status: 200 })),
    /unsupported artwork file/
  );
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("downloads pasted artwork URLs and follows redirects", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("/cover")) {
      return new Response(null, { status: 302, headers: { location: "/images/cover.png" } });
    }
    return new Response(PNG_BYTES, { headers: { "content-type": "application/octet-stream" } });
  };

  const artwork = await downloadArtworkFromUrl("https://example.com/cover", { fetchImpl, lookupImpl: publicLookup });
  assert.equal(artwork.mime, "image/png");
  assert.equal(artwork.extension, ".png");
  assert.deepEqual(requested, ["https://example.com/cover", "https://example.com/images/cover.png"]);
});

test("rejects pasted artwork URLs that aren't public web images", async () => {
  const fetchImpl = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(downloadArtworkFromUrl("ftp://example.com/a.png", { fetchImpl, lookupImpl: publicLookup }), { status: 400 });
  await assert.rejects(downloadArtworkFromUrl("not a url", { fetchImpl, lookupImpl: publicLookup }), { status: 400 });
  await assert.rejects(downloadArtworkFromUrl("http://192.168.0.83:9191/a.png", { fetchImpl }), { status: 400 });
  await assert.rejects(downloadArtworkFromUrl("http://[::1]/a.png", { fetchImpl }), { status: 400 });
  await assert.rejects(
    downloadArtworkFromUrl("https://nas.local/a.png", { fetchImpl, lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }] }),
    { status: 400 }
  );
  await assert.rejects(downloadArtworkFromUrl("https://example.com/page", { fetchImpl, lookupImpl: publicLookup }), { status: 415 });

  const redirectToLan = async () => new Response(null, { status: 301, headers: { location: "http://127.0.0.1/secret.png" } });
  await assert.rejects(downloadArtworkFromUrl("https://example.com/a.png", { fetchImpl: redirectToLan, lookupImpl: publicLookup }), { status: 400 });
});
