import nodemailer from "nodemailer";

let transporter;

export function emailDeliveryConfigured() {
  return Boolean((process.env.SMTP_HOST || "") && (process.env.EMAIL_FROM || process.env.SMTP_USER || ""));
}

export function registrationNotificationsConfigured() {
  return emailDeliveryConfigured();
}

export function emailSenderAddress() {
  const configured = String(process.env.EMAIL_FROM || process.env.SMTP_USER || "").trim();
  const bracketed = configured.match(/<([^<>]+)>/);
  return String(bracketed?.[1] || configured).trim();
}

export async function sendEmail(message) {
  if (!emailDeliveryConfigured()) {
    throw new Error("Email delivery is not configured");
  }

  const smtpUser = process.env.SMTP_USER || "";
  const smtpPass = process.env.SMTP_PASS || "";
  const from = process.env.EMAIL_FROM || smtpUser || "";

  transporter ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: parseBoolean(process.env.SMTP_SECURE, false),
    auth: smtpUser || smtpPass ? { user: smtpUser, pass: smtpPass } : undefined
  });

  return transporter.sendMail({
    ...message,
    from
  });
}

export async function notifyRegistrationAttempt(event) {
  const recipient = process.env.REGISTRATION_NOTIFY_EMAIL || emailSenderAddress();
  const message = {
    to: recipient,
    subject: `ShelfStream registration ${event.status}: ${event.username || "unknown"}`,
    text: [
      "ShelfStream registration attempt",
      "",
      `Status: ${event.status}`,
      `Reason: ${event.reason || "n/a"}`,
      `Username: ${event.username || "n/a"}`,
      `Display name: ${event.displayName || "n/a"}`,
      `IP address: ${event.ip || "n/a"}`,
      `User agent: ${event.userAgent || "n/a"}`,
      `Time: ${event.at || new Date().toISOString()}`
    ].join("\n")
  };

  if (!registrationNotificationsConfigured()) {
    console.warn(
      `Registration notification not sent; configure SMTP_HOST and EMAIL_FROM/SMTP_USER. ${JSON.stringify(message)}`
    );
    return;
  }

  await sendEmail(message);
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
