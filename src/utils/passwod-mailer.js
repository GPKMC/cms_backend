// utils/mailer.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

/**
 * Simple helper to send email
 */
export async function sendMail({ to, subject, text, html }) {
  const fromName = process.env.MAIL_FROM_NAME || "GPKMC eCampus";
  const fromEmail = process.env.MAIL_FROM || process.env.GMAIL_USER;

  return transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html: html || text,
  });
}
