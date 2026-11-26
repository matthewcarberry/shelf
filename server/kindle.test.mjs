import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A minimal SMTP server that records each message it receives, so the test
// exercises nodemailer's real SMTP path without sending anything outside.
async function startSmtpSink() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { to: [], data: "" };
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            return;
          }
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { to: [], data: "" };
          socket.write("250 OK\r\n");
          continue;
        }
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) {
          return;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") {
          socket.write("250-sink\r\n250 SIZE 52428800\r\n");
        } else if (command === "MAIL") {
          current.from = line;
          socket.write("250 OK\r\n");
        } else if (command === "RCPT") {
          current.to.push(line);
          socket.write("250 OK\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 Go ahead\r\n");
        } else if (command === "QUIT") {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, messages, close: () => server.close() };
}

function fakeStore(initial = {}) {
  let preferences = { kindleEmail: "", ...initial };
  return {
    getPreferences: () => preferences,
    setPreferences: async (_userId, patch) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    }
  };
}

const sink = await startSmtpSink();
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURE = "false";
process.env.EMAIL_FROM = "Shelf <books@example.test>";
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.KINDLE_MAX_ATTACHMENT_MB;

const {
  kindleDeliveryFile,
  kindleDeliverySettings,
  kindleMaxAttachmentBytes,
  sendBookToKindle
} = await import("./kindle.js");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-kindle-test-"));
test.after(async () => {
  sink.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("picks EPUB, PDF and converted EPUB files, and nothing else", () => {
  assert.equal(kindleDeliveryFile({ mediaType: "ebook", ext: ".epub", path: "/a.epub" }).contentType, "application/epub+zip");
  assert.equal(kindleDeliveryFile({ mediaType: "ebook", ext: ".PDF", path: "/a.pdf" }).contentType, "application/pdf");
  assert.deepEqual(
    kindleDeliveryFile({ mediaType: "ebook", ext: ".mobi", path: "/a.mobi", readingFormat: "epub", convertedPath: "/c.epub" }),
    { path: "/c.epub", ext: ".epub", contentType: "application/epub+zip" }
  );
  assert.equal(kindleDeliveryFile({ mediaType: "ebook", ext: ".mobi", path: "/a.mobi", readingFormat: null }), null);
  assert.equal(kindleDeliveryFile({ mediaType: "audiobook", ext: ".m4b", path: "/a.m4b" }), null);
});

test("keeps the encoded email under the SMTP size cap", () => {
  const limit = kindleMaxAttachmentBytes();
  const encoded = limit * (4 / 3) * (78 / 76);
  assert.ok(encoded < 25 * 1024 * 1024, `encoded ${encoded} bytes`);
  assert.ok(limit > 17 * 1024 * 1024, `limit ${limit} bytes`);

  process.env.KINDLE_MAX_ATTACHMENT_MB = "500";
  assert.ok(kindleMaxAttachmentBytes() * (4 / 3) < 50 * 1024 * 1024, "never above Amazon's 50 MB email limit");
  delete process.env.KINDLE_MAX_ATTACHMENT_MB;
});

test("shows the sender address in the Kindle settings", () => {
  const settings = kindleDeliverySettings(fakeStore({ kindleEmail: "reader@kindle.com" }), "u1");
  assert.equal(settings.senderEmail, "books@example.test");
  assert.equal(settings.kindleEmail, "reader@kindle.com");
  assert.equal(settings.deliveryConfigured, true);
});

test("emails a PDF to the saved Kindle address over SMTP", async () => {
  const filePath = path.join(tempDir, "book.pdf");
  await fs.writeFile(filePath, "%PDF-1.4 test");
  const store = fakeStore({ kindleEmail: "reader@kindle.com" });
  const before = sink.messages.length;

  const result = await sendBookToKindle({
    store,
    userId: "u1",
    book: { id: "b1", title: "The Test: A Novel", mediaType: "ebook", ext: ".pdf", path: filePath }
  });

  assert.equal(result.sent, true);
  const message = sink.messages[before];
  assert.match(message.from, /books@example\.test/);
  assert.match(message.to.join(), /reader@kindle\.com/);
  assert.match(message.data, /Content-Type: application\/pdf; name="The Test A Novel\.pdf"/);
});

test("saves a new Kindle address and refuses other addresses", async () => {
  const filePath = path.join(tempDir, "book.epub");
  await fs.writeFile(filePath, "epub");
  const store = fakeStore();
  const book = { id: "b2", title: "Epub", mediaType: "ebook", ext: ".epub", path: filePath };

  await assert.rejects(
    sendBookToKindle({ store, userId: "u1", book, kindleEmail: "someone@gmail.com" }),
    (error) => error.status === 400
  );
  await sendBookToKindle({ store, userId: "u1", book, kindleEmail: " New@Kindle.com " });
  assert.equal(store.getPreferences().kindleEmail, "new@kindle.com");
  assert.match(sink.messages.at(-1).data, /application\/epub\+zip/);
});

test("refuses files over the size limit and unsupported formats", async () => {
  const filePath = path.join(tempDir, "big.epub");
  await fs.writeFile(filePath, "");
  await fs.truncate(filePath, kindleMaxAttachmentBytes() + 1);
  const store = fakeStore({ kindleEmail: "reader@kindle.com" });

  await assert.rejects(
    sendBookToKindle({ store, userId: "u1", book: { id: "b3", title: "Big", mediaType: "ebook", ext: ".epub", path: filePath } }),
    (error) => error.status === 413
  );
  await assert.rejects(
    sendBookToKindle({ store, userId: "u1", book: { id: "b4", title: "Mobi", mediaType: "ebook", ext: ".mobi", path: filePath } }),
    (error) => error.status === 415
  );
});
