// src/functions/notification-model.js
import mongoose from "mongoose";
import User from "../users/user-model.js";
import {
  getTransporter,
  getPreviewUrl,
  getMailFrom,
  getReplyTo,
  applyDebugRouting,
  getDriverName,
} from "../utils/mailer.js";

const { Schema } = mongoose;

const notificationSchema = new Schema({
  courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
  type: {
    type: String,
    enum: [
      "material",
      "announcement",
      "assignment",
      "group-assignment",
      "quiz",
      "comment",
      "question",
      "assignment-submission",
      "group-assignment-submission",
      "question-submission"
    ],
    required: true
  },
  refId: { type: Schema.Types.ObjectId, required: true },

  title: { type: String },
  message: { type: String },

  submittedByUser: { type: Schema.Types.ObjectId, ref: "User" },
  submittedByGroup: { type: Schema.Types.ObjectId, ref: "Group" },

  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  recipients: [{ type: Schema.Types.ObjectId, ref: "User" }],
  readBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  archivedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  archived: { type: Boolean, default: false }
});

/* ---------------- helpers ---------------- */
function subjectFor(type) {
  switch (type) {
    case "announcement": return "[Course] New announcement";
    case "assignment": return "[Course] New assignment";
    case "group-assignment": return "[Course] New group assignment";
    case "material": return "[Course] New material";
    case "quiz": return "[Course] New quiz";
    case "question": return "[Course] New question";
    case "comment": return "[Course] New comment";
    case "assignment-submission": return "[Course] New assignment submission";
    case "group-assignment-submission": return "[Course] New group submission";
    case "question-submission": return "[Course] New question submission";
    default: return "[Course] Notification";
  }
}

/**
 * Build deep link for a given audience.
 * audience: 'student' | 'teacher'
 *
 * Student routes:
 *   Announcement: /student/dashboard/class/course-instance/{ci}
 *   Others:       /student/dashboard/class/course-instance/{ci}/{slug}/{refId}
 *
 * Teacher routes:
 *   Announcement: /teacher/dashboard/class/{ci}
 *   Others:       /teacher/dashboard/class/{ci}/Details/{Slug}/{refId}
 */
function deepLinkFor(doc, audience = "student") {
  const base = process.env.CLIENT_URL || "http://localhost:3000";

  if (audience === "student") {
    const ciPath = doc.courseInstance
      ? `/student/dashboard/class/course-instance/${doc.courseInstance}`
      : "";

    switch (doc.type) {
      case "announcement":
        return `${base}${ciPath}`;

      case "assignment":
      case "assignment-submission":
        return `${base}${ciPath}/assignment/${doc.refId}`;

      case "group-assignment":
      case "group-assignment-submission":
        return `${base}${ciPath}/groupAssignment/${doc.refId}`;

      case "material":
        return `${base}${ciPath}/materials/${doc.refId}`;

      case "quiz":
        return `${base}${ciPath}/quiz/${doc.refId}`;

      case "question":
      case "question-submission":
        return `${base}${ciPath}/question/${doc.refId}`;

      default:
        return `${base}${ciPath || ""}`;
    }
  } else {
    const ciPath = doc.courseInstance
      ? `/teacher/dashboard/class/${doc.courseInstance}`
      : "";

    switch (doc.type) {
      case "announcement":
        return `${base}${ciPath}`;

      case "assignment":
      case "assignment-submission":
        return `${base}${ciPath}/Details/Assignment/${doc.refId}`;

      case "group-assignment":
      case "group-assignment-submission":
        return `${base}${ciPath}/Details/groupAssignment/${doc.refId}`;

      case "material":
        return `${base}${ciPath}/Details/materials/${doc.refId}`;

      case "quiz":
        return `${base}${ciPath}/Details/quiz/${doc.refId}`;

      case "question":
      case "question-submission":
        return `${base}${ciPath}/Details/question/${doc.refId}`;

      default:
        return `${base}${ciPath || ""}`;
    }
  }
}

/* ---------------- hooks: email only on create ---------------- */
notificationSchema.pre("save", function(next) {
  this._wasNew = this.isNew;
  next();
});

notificationSchema.post("save", async function(doc) {
  try {
    if (!doc._wasNew) return;

    const recipientIds = (doc.recipients || []).map(String);
    if (!recipientIds.length) return;

    // We need roles to decide audience link
    const users = await User.find({ _id: { $in: recipientIds } })
      .select("email username role")
      .lean();

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];

    // Partition recipients by role
    const studentEmails = [];
    const staffEmails = []; // teacher / admin / superadmin (anything not "student")
    for (const u of users) {
      if (!u?.email) continue;
      const role = String(u.role || "").toLowerCase();
      if (role === "student") studentEmails.push(u.email);
      else staffEmails.push(u.email);
    }

    if (!studentEmails.length && !staffEmails.length) return;

    // Reply-To = creator (if present)
    let creator = null;
    if (doc.createdBy) {
      creator = await User.findById(doc.createdBy).select("email username").lean();
    }

    const transporter = await getTransporter();
    const { email: fromAddr, name: fromName } = getMailFrom();
    const { replyToEmail, replyToName } = getReplyTo({
      creatorEmail: creator?.email,
      creatorName: creator?.username,
    });

    const subject = subjectFor(doc.type);
    const title = doc.title || "";
    const message = doc.message || "";

    const buildBodies = (link) => ({
      text: `${title ? title + "\n" : ""}${message || ""}\n\nOpen: ${link}`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;">
          ${title ? `<h3 style="margin:0 0 8px 0;">${title}</h3>` : ""}
          ${message ? `<p style="margin:0 0 12px 0;white-space:pre-line;">${message}</p>` : ""}
          <p><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;text-decoration:none;">Open in eCampus</a></p>
        </div>
      `,
    });

    async function sendTo(list, audience) {
      const emails = uniq(list);
      if (!emails.length) return;

      const link = deepLinkFor(doc, audience);
      const { text, html } = buildBodies(link);
      const { to, bcc } = applyDebugRouting({ to: undefined, bcc: emails });

      console.log("[notif:mail] driver=", getDriverName(), "audience=", audience);
      console.log("[notif:mail] recipients=", to || bcc);

      const info = await transporter.sendMail({
        from: `${fromName} <${fromAddr}>`,
        to,
        bcc,
        replyTo: `${replyToName} <${replyToEmail}>`,
        subject,
        text,
        html,
      });

      const preview = getPreviewUrl(info);
      if (preview) console.log(`📧 Ethereal preview (${audience}):`, preview);
      else console.log(`📧 Email sent (${audience}):`, info.messageId);
    }

    // Send per audience
    await sendTo(studentEmails, "student");
    await sendTo(staffEmails, "teacher");
  } catch (e) {
    console.error("notification email error:", e);
  }
});

export default mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
