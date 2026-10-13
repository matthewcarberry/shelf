import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const TEXT_ENTRY_PATTERN = /\.(?:xhtml?|html?|opf|ncx|css|xml|svg|txt)$/i;

/**
 * Gmail sometimes rejects an otherwise valid EPUB because its archive contains
 * a suspicious external link or an unsafe HTML construct. Build a temporary
 * delivery copy only after that rejection; the library's original is never
 * changed.
 */
export async function createKindleDeliveryCopy(sourcePath) {
  const source = await JSZip.loadAsync(await fs.readFile(sourcePath));
  const output = new JSZip();

  // EPUB requires this entry to be the first entry and uncompressed.
  output.file("mimetype", "application/epub+zip", {
    compression: "STORE",
    createFolders: false
  });

  for (const entry of Object.values(source.files)) {
    if (entry.dir || entry.name === "mimetype" || /^oceanofpdf(?:\.com)?$/i.test(entry.name)) {
      continue;
    }

    const data = await entry.async("nodebuffer");
    const content = TEXT_ENTRY_PATTERN.test(entry.name)
      ? sanitizeEpubText(data.toString("utf8"))
      : data;

    output.file(entry.name, content, {
      compression: "DEFLATE",
      createFolders: false
    });
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "shelfstream-kindle-"));
  const temporaryPath = path.join(temporaryDirectory, path.basename(sourcePath));
  await fs.writeFile(
    temporaryPath,
    await output.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  );

  return {
    path: temporaryPath,
    async cleanup() {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
}

export function sanitizeEpubText(value) {
  return value
    // Remove executable HTML and inline event handlers from the delivery copy.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // External links are not needed by Kindle's importer and can trigger Gmail
    // content scanning. Keep the surrounding prose, but drop the linked block.
    .replace(/<a\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["'][^>]*>[\s\S]*?<\/a\s*>/gi, "")
    .replace(/<link\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*["']https?:\/\/[^"']+["']/gi, "")
    // Some EPUB distributors leave a standalone attribution file and repeated
    // visible domain markers in the XHTML. They are not book content and are a
    // common reason Gmail treats the archive as suspicious.
    .replace(/oceanofpdf(?:\.com)?/gi, "");
}

export function isGmailSecurityBlock(error) {
  const response = String(error?.response || "");
  const message = String(error?.message || "");
  const responseCode = Number(error?.responseCode);
  return responseCode === 552
    && /5\.7\.0|BlockedMessage|potential security issue/i.test(`${response}\n${message}`);
}
