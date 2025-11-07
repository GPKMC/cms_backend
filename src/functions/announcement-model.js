import mongoose from "mongoose";
const { Schema, Types } = mongoose;

// Mailer + User
import User from "../users/user-model.js";
import {
  getTransporter,
  getPreviewUrl,
  getMailFrom,
  getReplyTo,
  applyDebugRouting,
  getDriverName,
} from "../utils/mailer.js";

/** Reusable sub-schemas */
const FileSchema = new Schema(
  {
    url: { type: String, required: true }, // will store like /uploads/announcement/images/...
    originalname: String,
    filetype: String,
    size: Number,
    caption: String,
  },
  { _id: false }
);

const LinkSchema = new Schema(
  {
    label: String,
    url: {
      type: String,
      required: true,
      match: /^https?:\/\//i,
    },
  },
  { _id: false }
);

/** Audience (who can view) */
const AudienceSchema = new Schema(
  {
    mode: {
      type: String,
      enum: ["all", "faculty", "batches"],
      default: "all",
      required: true,
    },

    // Faculty IDs (e.g. BCA, BBA...)
    facultyIds: [{ type: Types.ObjectId, ref: "Faculty" }],

    // Batch IDs
    batchIds: [{ type: Types.ObjectId, ref: "Batch" }],
  },
  { _id: false }
);

/** Types */
export const ANNOUNCEMENT_TYPES = [
  "general",
  "event",
  "seminar",
  "exam",
  "result",
  "cultural",
  "eca",
];

const AnnouncementSchema = new Schema(
  {
    type: { type: String, enum: ANNOUNCEMENT_TYPES, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 500 },
    contentHtml: String,

    postedBy: { type: Types.ObjectId, ref: "User" },

    images: [FileSchema],
    files: [FileSchema],
    links: [LinkSchema],

    audience: { type: AudienceSchema, default: { mode: "all" } },

    published: { type: Boolean, default: true },
    publishAt: { type: Date },
    expiresAt: { type: Date },

    pinned: { type: Boolean, default: false },
    priority: {
      type: String,
      enum: ["normal", "high", "urgent"],
      default: "normal",
    },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/** Indexes */
AnnouncementSchema.index({ createdAt: -1 });
AnnouncementSchema.index({ type: 1, createdAt: -1 });
AnnouncementSchema.index({ title: "text", summary: "text", contentHtml: "text" });
AnnouncementSchema.index({ "audience.mode": 1 });
AnnouncementSchema.index({ "audience.facultyIds": 1 });
AnnouncementSchema.index({ "audience.batchIds": 1 });

AnnouncementSchema.path("audience").validate(function (aud) {
  if (!aud) return true;
  if (aud.mode === "faculty")
    return Array.isArray(aud.facultyIds) && aud.facultyIds.length > 0;
  if (aud.mode === "batches")
    return Array.isArray(aud.batchIds) && aud.batchIds.length > 0;
  return true;
});

/* ---------------- EMAIL: audience-resolve + send ---------------- */

const toObjectIds = (ids = []) =>
  (ids || [])
    .map((id) => {
      if (id instanceof Types.ObjectId) return id;
      if (!id) return null;
      return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
    })
    .filter(Boolean);

// Role-specific link for announcements (list page).
function deepLinkForAnnouncement(audience /* 'student' | 'teacher' */, doc) {
  const base = process.env.CLIENT_URL || "http://localhost:3000";
  return audience === "student"
    ? `${base}/student/dashboard/announcements`
    : `${base}/teacher/dashboard/announcements`;
}

/**
 * Resolve audience -> { studentUsers, staffUsers }
 */
async function resolveAudienceUsers(aud) {
  const staffRegex = [/teacher/i, /admin/i, /superadmin/i];

  let studentUsers = [];
  let staffUsers = [];

  // 1) Everyone
  if (!aud || aud.mode === "all") {
    [studentUsers, staffUsers] = await Promise.all([
      User.find({ role: /student/i }).select("email role username").lean(),
      User.find({ $or: staffRegex.map((r) => ({ role: r })) })
        .select("email role username")
        .lean(),
    ]);
    return { studentUsers, staffUsers };
  }

  // 2) Faculty-based: all teachers/admins + students in those faculties
  if (aud.mode === "faculty") {
    const facultyIds = toObjectIds(aud.facultyIds || []);
    if (!facultyIds.length) return { studentUsers, staffUsers };

    const facultyCond = {
      $or: [
        { faculty: { $in: facultyIds } },
        { facultyId: { $in: facultyIds } },
        { faculties: { $in: facultyIds } },
        { facultyIds: { $in: facultyIds } },
        { "profile.faculty": { $in: facultyIds } },
        { "profile.faculties": { $in: facultyIds } },
      ],
    };

    staffUsers = await User.find({
      $or: staffRegex.map((r) => ({ role: r })),
      ...facultyCond,
    })
      .select("email role username")
      .lean();

    studentUsers = await User.find({ role: /student/i, ...facultyCond })
      .select("email role username")
      .lean();

    return { studentUsers, staffUsers };
  }

  // 3) Batch-based: students in those batches
  if (aud.mode === "batches") {
    const batchIds = toObjectIds(aud.batchIds || []);
    if (!batchIds.length) return { studentUsers, staffUsers };

    const batchCond = {
      $or: [
        { batch: { $in: batchIds } },
        { batchId: { $in: batchIds } },
        { batches: { $in: batchIds } },
        { batchIds: { $in: batchIds } },
        { "profile.batch": { $in: batchIds } },
        { "profile.batches": { $in: batchIds } },
      ],
    };

    studentUsers = await User.find({ role: /student/i, ...batchCond })
      .select("email role username")
      .lean();

    return { studentUsers, staffUsers };
  }

  return { studentUsers, staffUsers };
}

const uniqEmails = (users) =>
  [...new Set((users || []).map((u) => u?.email).filter(Boolean))];

async function sendAnnouncementEmails({ doc, audience, recipients }) {
  if (!recipients.length) return;

  const transporter = await getTransporter();
  const { email: fromAddr, name: fromName } = getMailFrom();

  // Reply-To = postedBy (if exists)
  let poster = null;
  if (doc.postedBy) {
    poster = await User.findById(doc.postedBy)
      .select("email username")
      .lean();
  }
  const { replyToEmail, replyToName } = getReplyTo({
    creatorEmail: poster?.email,
    creatorName: poster?.username,
  });

  const subject = `[Announcement] ${doc.title || "New update"}`;
  const link = deepLinkForAnnouncement(audience, doc);
  const summary = doc.summary || "";
  const text = `${doc.title || "Announcement"}\n${summary}\n\nOpen: ${link}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;">
      <h3 style="margin:0 0 8px 0;">${doc.title || "Announcement"}</h3>
      ${
        summary
          ? `<p style="margin:0 0 12px 0;white-space:pre-line;">${summary}</p>`
          : ""
      }
      <p><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;">Open in eCampus</a></p>
    </div>
  `;

  const { to, bcc } = applyDebugRouting({ to: undefined, bcc: recipients });

  console.log("[announce:mail] driver=", getDriverName(), "audience=", audience);
  console.log("[announce:mail] recipients=", to || bcc);

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
  else console.log(`📧 Announcement email sent (${audience}):`, info.messageId);
}

// Only on create & when publishable
AnnouncementSchema.pre("save", function (next) {
  this._wasNew = this.isNew;
  next();
});

AnnouncementSchema.post("save", async function (doc) {
  try {
    if (!doc._wasNew) return;
    if (doc.isDeleted) return;
    if (doc.published === false) return;
    if (doc.publishAt && doc.publishAt > new Date()) return;

    const { studentUsers, staffUsers } = await resolveAudienceUsers(
      doc.audience || { mode: "all" }
    );
    const studentEmails = uniqEmails(studentUsers);
    const staffEmails = uniqEmails(staffUsers);

    if (!studentEmails.length && !staffEmails.length) {
      console.log("[announce:mail] no recipients resolved");
      return;
    }

    await sendAnnouncementEmails({
      doc,
      audience: "student",
      recipients: studentEmails,
    });
    await sendAnnouncementEmails({
      doc,
      audience: "teacher",
      recipients: staffEmails,
    });
  } catch (e) {
    console.error("announcement email error:", e);
  }
});

/* ---------------- COMPILE MODEL AFTER HOOKS ---------------- */
const Announcement =
  mongoose.models.Announcement ||
  mongoose.model("Announcement", AnnouncementSchema);

export default Announcement;
