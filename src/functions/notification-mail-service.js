// updated sender block (e.g., inside your notification service/controller)
import {
  getTransporter,
  getPreviewUrl,
  getMailFrom,
  getReplyTo,
  applyDebugRouting,
} from "../utils/mailer.js";
// (keep/remove these if actually used)
// import User from "../user/user-model.js";
// import Notification from "./notification-model.js";

// Build your recipient list earlier in code:
/// const toList = students.map(s => s.email).filter(Boolean);
/// const creator = { email: teacher.email, username: teacher.username };

const transporter = await getTransporter();

// System "From" (always noreply@gpkmc.edu.np per .env)
const { email: fromAddr, name: fromName } = getMailFrom();

// Reply-To goes to the posting teacher (fallback handled by helper/.env)
const { replyToEmail, replyToName } = getReplyTo({
  creatorEmail: creator?.email,
  creatorName: creator?.username,
});

// Route to SEND_TO_DEBUG if set; otherwise BCC real recipients
const { to, bcc } = applyDebugRouting({
  to: "noreply.gpkmc@gmail.com",    // we send via BCC normally
  bcc: toList,      // array of recipient emails
});

// Safety: no recipients?
if (!to && (!Array.isArray(bcc) || bcc.length === 0)) {
  console.warn("⚠️ No email recipients resolved; skipping send.");
} else {
  const info = await transporter.sendMail({
    from: `${fromName} <${fromAddr}>`,                // => noreply@gpkmc.edu.np
    to,                                               // SEND_TO_DEBUG if present
    bcc,                                              // or real recipients hidden
    replyTo: `${replyToName} <${replyToEmail}>`,
    subject,
    text,
    html,
  });

  // In dev (MAIL_DRIVER=ethereal) this prints a preview URL
  const preview = getPreviewUrl(info);
  if (preview) {
    console.log("📧 Ethereal preview:", preview);
  } else {
    console.log("📧 Email sent:", info.messageId);
  }
}
