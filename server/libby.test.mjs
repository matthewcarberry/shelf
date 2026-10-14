import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "./store.js";
import {
  LibbyService,
  audiobookTracks,
  createLibbyApi,
  libbyBookId,
  loanReadingMode,
  parseLibbyBookId
} from "./libby.js";

const AUDIO = Buffer.from("0123456789abcdefghij");
const EPUB = Buffer.from("PK-open-epub");

function card() {
  return { cardId: "111", advantageKey: "testlib", library: { name: "Test Library" } };
}

function audiobookLoan() {
  return {
    id: "900",
    cardId: "111",
    title: "Test Audiobook",
    firstCreatorName: "Test Author",
    checkoutDate: "2026-10-01T00:00:00Z",
    expireDate: "2026-10-22T00:00:00Z",
    type: { id: "audiobook" },
    covers: { cover150Wide: { width: 150, href: "http://img/small.jpg" }, cover510Wide: { width: 510, href: "http://img/big.jpg" } },
    formats: [{ id: "audiobook-overdrive" }, { id: "audiobook-mp3" }]
  };
}

function openEbookLoan() {
  return {
    id: "901",
    cardId: "111",
    title: "Open Book",
    firstCreatorName: "Author Two",
    type: { id: "ebook" },
    formats: [{ id: "ebook-overdrive" }, { id: "ebook-epub-open" }, { id: "ebook-epub-adobe" }]
  };
}

function drmEbookLoan() {
  return {
    id: "902",
    cardId: "111",
    title: "Locked Book",
    type: { id: "ebook" },
    formats: [{ id: "ebook-overdrive" }, { id: "ebook-epub-adobe" }, { id: "ebook-kindle" }]
  };
}

const OPENBOOK = {
  nav: {
    toc: [
      { title: "Opening Credits", path: "{AAAAAAAA-BBBB-CCCC-9999-ABCDEF123456}Part01.mp3" },
      { title: "Chapter 1", path: "{AAAAAAAA-BBBB-CCCC-9999-ABCDEF123456}Part01.mp3#30" },
      { title: "Chapter 2", path: "{AAAAAAAA-BBBB-CCCC-9999-ABCDEF123456}Part02.mp3#12" }
    ]
  },
  spine: [
    { path: "part1.mp3?token=a", "audio-duration": 100, "-odread-original-path": "{AAAAAAAA-BBBB-CCCC-9999-ABCDEF123456}Part01.mp3" },
    { path: "part2.mp3?token=b", "audio-duration": 50.5, "-odread-original-path": "{AAAAAAAA-BBBB-CCCC-9999-ABCDEF123456}Part02.mp3" }
  ]
};

// A stand-in for Libby's servers, recording every request it gets.
function fakeLibby(options = {}) {
  const { loans = [audiobookLoan(), openEbookLoan(), drmEbookLoan()], acceptCode = "12345678" } = options;
  const calls = [];
  const state = { loans, copied: false };
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
  async function fetchImpl(url, init = {}) {
    const href = String(url);
    calls.push({ href, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const auth = init.headers?.Authorization;
    if (href.endsWith("/chip?client=dewey")) {
      // A refresh after Libby copied the account onto the new chip returns a linked token.
      if (auth === "Bearer new-chip-token" && state.copied) return json({ chip: "c", identity: "secret-identity-token" });
      if (auth) return json({ chip: "c", identity: auth.slice("Bearer ".length) });
      return json({ chip: "c", identity: options.newChipToken || "secret-identity-token" });
    }
    if (href.endsWith("/chip/clone/code") && (init.method || "GET") === "GET") {
      return json({ code: "24681357", expiry: Math.floor(Date.now() / 1000) + 60 });
    }
    if (href.endsWith("/chip/clone/code")) {
      return new URLSearchParams(init.body).get("code") === acceptCode ? json({}) : new Response("", { status: 400 });
    }
    if (href.endsWith("/chip/sync")) {
      if (auth === "Bearer new-chip-token") return json({ result: "synchronized", cards: [], loans: [] });
      if (auth !== "Bearer secret-identity-token") return new Response("", { status: 401 });
      return json({ result: "synchronized", cards: [card()], loans: state.loans });
    }
    if (href.includes("/open/audiobook/card/111/title/900")) {
      return json({ message: "m=1", urls: { web: "https://web.libby.test/book/", openbook: "https://web.libby.test/book/openbook.json" } });
    }
    if (href === "https://web.libby.test/book/?m=1") {
      return new Response("", { status: 302, headers: { location: "https://web.libby.test/book/ready", "set-cookie": "od=session; Path=/" } });
    }
    if (href === "https://web.libby.test/book/ready") return new Response("ok");
    if (href === "https://web.libby.test/book/openbook.json") {
      return init.headers?.Cookie === "od=session" ? json(OPENBOOK) : new Response("", { status: 403 });
    }
    if (href.startsWith("https://web.libby.test/book/part1.mp3")) {
      if (init.headers?.Cookie !== "od=session") return new Response("", { status: 403 });
      const range = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || "");
      if (range) {
        const slice = AUDIO.subarray(Number(range[1]), Number(range[2]) + 1);
        return new Response(slice, {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${range[1]}-${range[2]}/${AUDIO.length}`, "content-length": String(slice.length) }
        });
      }
      return new Response(AUDIO, { headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO.length) } });
    }
    if (href.endsWith("/card/111/loan/901/fulfill/ebook-epub-open")) {
      return new Response("", { status: 302, headers: { location: "https://files.libby.test/open.epub" } });
    }
    if (href === "https://files.libby.test/open.epub") return new Response(EPUB);
    return new Response("unexpected", { status: 500 });
  }
  return { calls, state, fetchImpl };
}

async function setup(options) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-libby-"));
  const store = new SqliteStore(path.join(workspace, "shelfstream.json"));
  await store.init();
  const fake = fakeLibby(options);
  const service = new LibbyService(store, workspace, { api: createLibbyApi({ fetchImpl: fake.fetchImpl }) });
  return {
    workspace,
    store,
    fake,
    service,
    async cleanup() {
      store.close();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  };
}

test("chooses how each loan opens and never unlocks DRM formats", () => {
  assert.equal(loanReadingMode(audiobookLoan()), "audio");
  assert.equal(loanReadingMode(openEbookLoan()), "epub");
  assert.equal(loanReadingMode(drmEbookLoan()), "libby");
  assert.equal(loanReadingMode({ type: { id: "ebook" }, formats: [{ id: "ebook-pdf-open" }] }), "pdf");
  assert.equal(
    loanReadingMode({ type: { id: "ebook" }, formats: [{ id: "ebook-epub-open" }, { id: "ebook-kindle", isLockedIn: true }] }),
    "libby"
  );
  assert.equal(loanReadingMode({ type: { id: "magazine" }, formats: [{ id: "magazine-overdrive" }] }), "libby");
  assert.deepEqual(parseLibbyBookId(libbyBookId("111", "900")), { cardId: "111", titleId: "900" });
  assert.equal(parseLibbyBookId("book-1"), null);
  assert.equal(parseLibbyBookId("libby-1-2/../x"), null);
});

test("splits a Libby audiobook into tracks named after their first chapter", () => {
  const tracks = audiobookTracks(OPENBOOK, "https://web.libby.test/book/");
  assert.deepEqual(tracks.map((track) => [track.title, track.durationSeconds, track.upstreamUrl]), [
    ["Opening Credits", 100, "https://web.libby.test/book/part1.mp3?token=a"],
    ["Chapter 2", 50.5, "https://web.libby.test/book/part2.mp3?token=b"]
  ]);
});

test("links with a setup code, stores the token encrypted and lists loans as books", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.service.link("user-1", "1234"), /8-digit/);
    await assert.rejects(ctx.service.link("user-1", "87654321"), /didn't accept that code/);

    const status = await ctx.service.link("user-1", "1234 5678");
    assert.equal(status.linked, true);
    assert.deepEqual(status.libraries, ["Test Library"]);

    const sqlite = new DatabaseSync(path.join(ctx.workspace, "shelfstream.sqlite"), { readOnly: true });
    const stored = sqlite.prepare("SELECT identity FROM libby_accounts WHERE user_id = ?").get("user-1").identity;
    sqlite.close();
    assert.doesNotMatch(stored, /secret-identity-token/);

    const books = await ctx.service.loans("user-1");
    assert.deepEqual(books.map((book) => [book.id, book.mediaType, book.readingFormat, book.libby.mode]), [
      ["libby-111-900", "audiobook", "audio", "audio"],
      ["libby-111-901", "ebook", "epub", "epub"],
      ["libby-111-902", "ebook", null, "libby"]
    ]);
    assert.equal(books[0].coverUrl, "https://img/big.jpg");
    assert.equal(books[0].libby.dueAt, "2026-10-22T00:00:00Z");
    assert.equal(books[2].status, "unsupported");
    assert.equal(books[2].libby.libbyUrl, "https://libbyapp.com/library/testlib/everything/page-1/902");

    await assert.rejects(ctx.service.loans("user-2"), /Link your Libby account first/);
  } finally {
    await ctx.cleanup();
  }
});

test("streams audiobook parts through shelf with range requests", async () => {
  const ctx = await setup();
  try {
    await ctx.service.link("user-1", "12345678");
    const { loan } = await ctx.service.findLoan("user-1", "libby-111-900");
    const session = await ctx.service.audioSession("user-1", loan);
    assert.equal(session.tracks.length, 2);

    const req = new PassThrough();
    req.headers = { range: "bytes=2-5" };
    const res = new PassThrough();
    const headers = {};
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.setHeader = (name, value) => {
      headers[name.toLowerCase()] = value;
    };
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve) => res.on("end", resolve));
    await ctx.service.streamAudio(req, res, "user-1", loan, 0);
    await finished;

    assert.equal(res.statusCode, 206);
    assert.equal(headers["content-range"], "bytes 2-5/20");
    assert.equal(Buffer.concat(chunks).toString(), "2345");
  } finally {
    await ctx.cleanup();
  }
});

test("keeps an open EPUB only while the loan lasts", async () => {
  const ctx = await setup();
  try {
    await ctx.service.link("user-1", "12345678");
    const { loan } = await ctx.service.findLoan("user-1", "libby-111-901");
    const filePath = await ctx.service.openFilePath("user-1", loan, "epub");
    assert.deepEqual(await fs.readFile(filePath), EPUB);

    ctx.fake.state.loans = [audiobookLoan()];
    await ctx.service.loans("user-1", { force: true });
    await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
    assert.equal(await ctx.service.findLoan("user-1", "libby-111-901"), null);
  } finally {
    await ctx.cleanup();
  }
});

test("unlinking forgets the account and its cached books", async () => {
  const ctx = await setup();
  try {
    await ctx.service.link("user-1", "12345678");
    const { loan } = await ctx.service.findLoan("user-1", "libby-111-901");
    const filePath = await ctx.service.openFilePath("user-1", loan, "epub");
    await ctx.service.unlink("user-1");
    assert.equal(ctx.service.status("user-1").linked, false);
    await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
  } finally {
    await ctx.cleanup();
  }
});

test("links by showing a code that is typed into Libby", async () => {
  const ctx = await setup({ newChipToken: "new-chip-token" });
  try {
    assert.deepEqual(await ctx.service.checkLink("user-1"), { state: "none" });
    const started = await ctx.service.startLink("user-1");
    assert.equal(started.code, "24681357");
    assert.equal((await ctx.service.checkLink("user-1")).state, "waiting");
    assert.equal(ctx.service.status("user-1").linked, false);

    ctx.fake.state.copied = true;
    const linked = await ctx.service.checkLink("user-1");
    assert.equal(linked.state, "linked");
    assert.deepEqual(linked.libraries, ["Test Library"]);
    assert.equal((await ctx.service.loans("user-1")).length, 3);
  } finally {
    await ctx.cleanup();
  }
});
