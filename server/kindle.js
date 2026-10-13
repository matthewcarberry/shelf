import fs from "node:fs/promises";
import path from "node:path";
import sanitize from "sanitize-filename";
import { emailDeliveryConfigured, emailSenderAddress, sendEmail } from "./notifications.js";
import { createKindleDeliveryCopy, isGmailSecurityBlock } from "./epub-delivery.js";

const DEFAULT_MAX_ATTACHMENT_MB = 25;

export function kindleDeliverySettings(store, userId) {
  const preferences = store.getPreferences(userId);
  return {
    kindleEmail: normalizeKindleEmail(preferences.kindleEmail),
    deliveryConfigured: emailDeliveryConfigured(),
    senderEmail: emailSenderAddress() || null,
    maxAttachmentBytes: kindleMaxAttachmentBytes()
  };
}

export function normalizeKindleEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

export function validateKindleEmail(value) {
  const email = normalizeKindleEmail(value);
  if (!email) {
    return "Enter your Send to Kindle email address";
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@kindle\.com$/i.test(email)) {
    return "Use the @kindle.com address assigned to your Kindle device or app";
  }
  return null;
}

export async function sendBookToKindle({ store, userId, book, kindleEmail }) {
  if (!emailDeliveryConfigured()) {
    const error = new Error("ShelfStream email delivery is not configured. Ask an administrator to configure SMTP.");
    error.status = 503;
    throw error;
  }

  if (book.mediaType === "audiobook" || String(book.ext || "").toLowerCase() !== ".epub") {
    const error = new Error("Send to Kindle is available only for EPUB files");
    error.status = 415;
    throw error;
  }

  const email = normalizeKindleEmail(kindleEmail || store.getPreferences(userId).kindleEmail);
  const validationError = validateKindleEmail(email);
  if (validationError) {
    const error = new Error(validationError);
    error.status = 400;
    throw error;
  }

  const filePath = book.path;
  const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
  if (!stat?.isFile()) {
    const error = new Error("The EPUB file could not be found on the ShelfStream server");
    error.status = 404;
    throw error;
  }

  const maxAttachmentBytes = kindleMaxAttachmentBytes();
  if (stat.size > maxAttachmentBytes) {
    const error = new Error(
      `This EPUB is larger than ShelfStream's ${formatMegabytes(maxAttachmentBytes)} MB email limit`
    );
    error.status = 413;
    throw error;
  }

  if (email !== store.getPreferences(userId).kindleEmail) {
    await store.setPreferences(userId, { kindleEmail: email });
  }

  const filename = kindleFilename(book);
  const message = {
    to: email,
    subject: book.title || filename,
    text: `Sent from ShelfStream: ${book.title || filename}`,
    attachments: [
      {
        filename,
        path: filePath,
        contentType: "application/epub+zip"
      }
    ]
  };

  try {
    await sendEmail(message);
  } catch (error) {
    if (!isGmailSecurityBlock(error)) {
      throw error;
    }

    // Gmail scans EPUB archives and can reject embedded external links even
    // when the EPUB is valid. Retry once with a temporary clean delivery copy.
    const deliveryCopy = await createKindleDeliveryCopy(filePath);
    try {
      await sendEmail({
        ...message,
        attachments: [{
          ...message.attachments[0],
          path: deliveryCopy.path
        }]
      });
    } finally {
      await deliveryCopy.cleanup();
    }
  }

  return {
    sent: true,
    kindleEmail: email,
    bookId: book.id,
    sentAt: new Date().toISOString()
  };
}

export function kindleMaxAttachmentBytes() {
  const configured = Number(process.env.KINDLE_MAX_ATTACHMENT_MB || DEFAULT_MAX_ATTACHMENT_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ATTACHMENT_MB;
  return Math.floor(megabytes * 1024 * 1024);
}

function kindleFilename(book) {
  const title = sanitize(String(book.title || path.basename(book.path, ".epub"))) || "ShelfStream book";
  return `${title}.epub`;
}

function formatMegabytes(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
