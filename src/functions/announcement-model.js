// src/announcement/announcement-model.js
import mongoose from "mongoose";
const { Schema, Types } = mongoose;

/** Reusable sub-schemas */
const FileSchema = new Schema(
  {
    url: { type: String, required: true },   // stored file path/URL
    originalname: String,
    filetype: String,                        // MIME (e.g., image/png, application/pdf)
    size: Number,                            // bytes
    caption: String,                         // nice for images/posters
  },
  { _id: false }
);

const LinkSchema = new Schema(
  {
    label: String,
    url: {
      type: String,
      required: true,
      match: /^https?:\/\//i,               // allow only http/https
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
    // When mode === 'faculty': specific teachers (User._id)
    facultyIds: [{ type: Types.ObjectId, ref: "User" }],
    // When mode === 'batches': target batches (Batch._id)
    batchIds: [{ type: Types.ObjectId, ref: "Batch" }],
  },
  { _id: false }
);

/** Types you can pick in UI; add/remove as needed */
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

    // keep content simple; store HTML (or swap to JSON if you prefer TipTap JSON)
    contentHtml: String,

    // who posted (optional but recommended)
    postedBy: { type: Types.ObjectId, ref: "User" },

    // attachments
    images: [FileSchema],     // posters, banners, photos
    files: [FileSchema],      // PDFs, DOCX, etc.
    links: [LinkSchema],      // external refs, registration forms, etc.

    // audience targeting
    audience: {
      type: AudienceSchema,
      default: { mode: "all" },
    },

    // basic publishing controls (optional)
    published: { type: Boolean, default: true },
    publishAt: { type: Date },
    expiresAt: { type: Date },
    pinned: { type: Boolean, default: false },
    priority: { type: String, enum: ["normal", "high", "urgent"], default: "normal" },

    // soft delete (optional)
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/** Helpful indexes */
AnnouncementSchema.index({ createdAt: -1 });
AnnouncementSchema.index({ type: 1, createdAt: -1 });
AnnouncementSchema.index({ title: "text", summary: "text", contentHtml: "text" });

// Audience indexes
AnnouncementSchema.index({ "audience.mode": 1 });
AnnouncementSchema.index({ "audience.facultyIds": 1 });
AnnouncementSchema.index({ "audience.batchIds": 1 });

/** Minimal validation: require IDs when targeted */
AnnouncementSchema.path("audience").validate(function (aud) {
  if (!aud) return true;
  if (aud.mode === "faculty") return Array.isArray(aud.facultyIds) && aud.facultyIds.length > 0;
  if (aud.mode === "batches") return Array.isArray(aud.batchIds) && aud.batchIds.length > 0;
  return true; // 'all'
}, "When audience.mode is targeted, provide non-empty matching IDs.");

const Announcement = mongoose.model("Announcement", AnnouncementSchema);
export default Announcement;
