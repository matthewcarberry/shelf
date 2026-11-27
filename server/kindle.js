import fs from "node:fs/promises";
import path from "node:path";
import sanitize from "sanitize-filename";
import { emailDeliveryConfigured, emailSenderAddress, sendEmail } from "./notifications.js";
import { createKindleDeliveryCopy, isGmailSecurityBlock } from "./epub-delivery.js";

const DEFAULT_MAX_ATTACHMENT_MB = 25;
const AMAZON_MAX_EMAIL_MB = 50;
// base64 makes 4 bytes from 3, plus a line break every 76 characters.
const BASE64_GROWTH = (4 / 3) * (78 / 76);
const MESSAGE_OVERHEAD_BYTES = 64 * 1024;
const KINDLE_CONTENT_TYPES = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf"
};

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
    const error = new Error("Shelf email delivery is not configured. Ask an administrator to configure SMTP.");
    error.status = 503;
    throw error;
  }

  const delivery = kindleDeliveryFile(book);
  if (!delivery) {
    const error = new Error("Send to Kindle works with EPUB and PDF books, and with books Shelf has converted to EPUB");
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

  const filePath = delivery.path;
  const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
  if (!stat?.isFile()) {
    const error = new Error("The book file could not be found on the Shelf server");
    error.status = 404;
    throw error;
  }

  const maxAttachmentBytes = kindleMaxAttachmentBytes();
  if (stat.size > maxAttachmentBytes) {
    const error = new Error(
      `This book is ${formatMegabytes(stat.size)} MB. Shelf can email books up to ${formatMegabytes(maxAttachmentBytes)} MB to Kindle.`
    );
    error.status = 413;
    throw error;
  }

  if (email !== store.getPreferences(userId).kindleEmail) {
    await store.setPreferences(userId, { kindleEmail: email });
  }

  const filename = kindleFilename(book, delivery.ext);
  const message = {
    to: email,
    subject: book.title || filename,
    text: `Sent from Shelf: ${book.title || filename}`,
    attachments: [
      {
        filename,
        path: filePath,
        contentType: delivery.contentType
      }
    ]
  };

  try {
    await sendEmail(message);
  } catch (error) {
    if (delivery.ext !== ".epub" || !isGmailSecurityBlock(error)) {
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

// Picks the file to email. Amazon's Send to Kindle accepts EPUB and PDF
// (MOBI/AZW are no longer accepted), so other formats go only once Shelf has
// converted them to EPUB.
export function kindleDeliveryFile(book) {
  if (!book || book.mediaType === "audiobook") {
    return null;
  }
  const ext = String(book.ext || "").toLowerCase();
  if (ext === ".epub" || ext === ".pdf") {
    return { path: book.path, ext, contentType: KINDLE_CONTENT_TYPES[ext] };
  }
  if (book.convertedPath && book.readingFormat === "epub") {
    return { path: book.convertedPath, ext: ".epub", contentType: KINDLE_CONTENT_TYPES[".epub"] };
  }
  return null;
}

// The largest book file Shelf will email. Amazon takes up to 50 MB per email,
// but most SMTP providers (Gmail, Outlook) cap messages at 25 MB, and base64
// attachment encoding grows a file by about 37%. So the default limit is the
// largest file whose encoded message fits in 25 MB. KINDLE_MAX_ATTACHMENT_MB
// sets the message size the SMTP provider allows.
export function kindleMaxAttachmentBytes() {
  const configured = Number(process.env.KINDLE_MAX_ATTACHMENT_MB || DEFAULT_MAX_ATTACHMENT_MB);
  const megabytes = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, AMAZON_MAX_EMAIL_MB)
    : DEFAULT_MAX_ATTACHMENT_MB;
  const messageBytes = megabytes * 1024 * 1024 - MESSAGE_OVERHEAD_BYTES;
  return Math.max(0, Math.floor(messageBytes / BASE64_GROWTH));
}

function kindleFilename(book, ext) {
  const title = sanitize(String(book.title || path.basename(book.path, path.extname(book.path)))) || "Shelf book";
  return `${title}${ext}`;
}

function formatMegabytes(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
