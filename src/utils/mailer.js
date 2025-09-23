// src/utils/mailer.js
import nodemailer from "nodemailer";

let cachedTransporter = null;
let cachedDriver = null;

/* ---------------- helpers driven by .env ---------------- */
function pickDriver() {
  const d = (process.env.MAIL_DRIVER || "").toLowerCase().trim();
  if (d) return d; // ethereal | smtp | gmail | gmail-oauth2 | console
  return process.env.NODE_ENV === "production" ? "smtp" : "ethereal";
}

export function getMailFrom() {
  const email = (process.env.MAIL_FROM || process.env.GMAIL_USER || "noreply@gpkmc.edu.np").trim();
  const name  = (process.env.MAIL_FROM_NAME || process.env.SENDER_DISPLAY || "GPKMC eCampus").trim();
  return { email, name };
}

export function getReplyTo({ creatorEmail, creatorName } = {}) {
  const replyToEmail = (creatorEmail || process.env.MAIL_REPLY_FALLBACK || "noreply@gpkmc.edu.np").trim();
  const replyToName  = creatorName || "Teacher";
  return { replyToEmail, replyToName };
}

export function applyDebugRouting({ to, bcc }) {
  const debug = (process.env.SEND_TO_DEBUG || "").trim();
  if (debug) return { to: debug, bcc: undefined }; // force all mail to one inbox in dev if set
  return { to, bcc };
}

export function getDriverName() {
  return cachedDriver || pickDriver();
}

/* ---------------- transporter factory ---------------- */
export async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const driver = pickDriver();
  cachedDriver = driver;
  console.log(`[mail] driver = ${driver}`);

  // 1) Console (no network)
  if (driver === "console") {
    cachedTransporter = {
      async sendMail(opts) {
        const { html, ...rest } = opts || {};
        console.log("MAIL[console]:", { ...rest, html: "(omitted)" });
        return { messageId: "console", previewUrl: null };
      },
      _driver: "console",
    };
    return cachedTransporter;
  }

  // 2) Ethereal (dev preview URL only; does NOT deliver to real inboxes)
  if (driver === "ethereal") {
    const testAccount = await nodemailer.createTestAccount();
    cachedTransporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    cachedTransporter._driver = "ethereal";
    return cachedTransporter;
  }

  // 3) SMTP (SendGrid/Mailtrap/Mailgun/SES/etc.)
  if (driver === "smtp") {
    // Prefer explicit host config if SENDGRID_API_KEY is provided
    if (process.env.SENDGRID_API_KEY) {
      cachedTransporter = nodemailer.createTransport({
        host: "smtp.sendgrid.net",
        port: 465,          // use 587 with secure:false if you prefer STARTTLS
        secure: true,
        auth: { user: "apikey", pass: process.env.SENDGRID_API_KEY },
      });
      cachedTransporter._driver = "smtp-sendgrid";
      return cachedTransporter;
    }

    // Otherwise fall back to SMTP_URL (must be set)
    if (!process.env.SMTP_URL) {
      throw new Error(
        'MAIL_DRIVER=smtp requires either SENDGRID_API_KEY or SMTP_URL (e.g., "smtp://localhost:1025" or "smtps://user:pass@smtp.provider.com:465").'
      );
    }
    cachedTransporter = nodemailer.createTransport(process.env.SMTP_URL);
    cachedTransporter._driver = "smtp-url";
    return cachedTransporter;
  }

  // 4) Gmail (App Password)
  if (driver === "gmail" || driver === "gmail-app") {
    const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw new Error("MAIL_DRIVER=gmail requires GMAIL_USER and GMAIL_APP_PASSWORD.");
    }
    cachedTransporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    cachedTransporter._driver = "gmail-app";
    return cachedTransporter;
  }

  // 5) Gmail OAuth2
  if (driver === "gmail-oauth2" || process.env.GMAIL_OAUTH === "true") {
    const { GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    if (!GMAIL_USER || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
      throw new Error("gmail-oauth2 requires GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.");
    }
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: GMAIL_USER,
        clientId: GMAIL_CLIENT_ID,
        clientSecret: GMAIL_CLIENT_SECRET,
        refreshToken: GMAIL_REFRESH_TOKEN,
      },
    });
    cachedTransporter._driver = "gmail-oauth2";
    return cachedTransporter;
  }

  throw new Error(`Unknown MAIL_DRIVER "${driver}". Use ethereal | smtp | gmail | gmail-oauth2 | console.`);
}

/* ---------------- preview URL for Ethereal ---------------- */
export function getPreviewUrl(info) {
  try {
    return nodemailer.getTestMessageUrl(info) || null;
  } catch {
    return null;
  }
}
