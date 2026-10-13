import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createKindleDeliveryCopy, isGmailSecurityBlock, sanitizeEpubText } from "./epub-delivery.js";

test("sanitizes executable markup and external delivery links", () => {
  const source = '<a href="https://oceanofpdf.com"><i>OceanofPDF.com</i></a><script>alert(1)</script><img src="https://example.com/a.jpg" onerror="bad()">';
  const clean = sanitizeEpubText(source);

  assert.doesNotMatch(clean, /oceanofpdf|script|onerror|https:\/\/example\.com/i);
});

test("creates a valid EPUB delivery copy without changing the source", async () => {
  const sourceZip = new JSZip();
  sourceZip.file("mimetype", "application/epub+zip");
  sourceZip.file("META-INF/container.xml", "<container/>");
  sourceZip.file("OEBPS/content.xhtml", '<html><body><a href="https://oceanofpdf.com">OceanofPDF.com</a></body></html>');
  sourceZip.file("oceanofpdf.com", "marker");
  const sourcePath = `${process.env.TEMP || process.env.TMP}/shelfstream-epub-test-${Date.now()}.epub`;
  const fs = await import("node:fs/promises");
  await fs.writeFile(sourcePath, await sourceZip.generateAsync({ type: "nodebuffer" }));

  const copy = await createKindleDeliveryCopy(sourcePath);
  try {
    const result = await JSZip.loadAsync(await fs.readFile(copy.path));
    assert.equal(await result.file("mimetype").async("string"), "application/epub+zip");
    assert.equal(result.file("oceanofpdf.com"), null);
    assert.doesNotMatch(await result.file("OEBPS/content.xhtml").async("string"), /oceanofpdf/i);
  } finally {
    await copy.cleanup();
    await fs.rm(sourcePath, { force: true });
  }
});

test("recognizes Gmail's security rejection", () => {
  assert.equal(isGmailSecurityBlock({ responseCode: 552, response: "552 5.7.0 BlockedMessage" }), true);
  assert.equal(isGmailSecurityBlock({ responseCode: 552, response: "552 5.3.4 message too large" }), false);
});
