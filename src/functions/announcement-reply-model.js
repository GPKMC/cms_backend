import mongoose from "mongoose";
const { Schema, Types } = mongoose;

/** (Optional) tiny reusable file schema for attachments on replies */
const ReplyFileSchema = new Schema(
  {
    url: { type: String, required: true },
    originalname: String,
    filetype: String,
    size: Number,
    caption: String,
  },
  { _id: false }
);

/** Threaded replies (comments) for announcements */
const AnnouncementReplySchema = new Schema(
  {
    announcement: { type: Types.ObjectId, ref: "Announcement", required: true, index: true },
    parent:       { type: Types.ObjectId, ref: "AnnouncementReply", default: null, index: true }, // null = root
    author:       { type: Types.ObjectId, ref: "User", required: true, index: true },

    // keep same content style as announcements; sanitize server-side or at least on the client
    contentHtml:  { type: String, default: "" },

    files:        [ReplyFileSchema], // optional attachments
    isDeleted:    { type: Boolean, default: false },
    editedAt:     { type: Date },
  },
  { timestamps: true }
);

AnnouncementReplySchema.index({ announcement: 1, parent: 1, createdAt: 1 });

const AnnouncementReply = mongoose.model("AnnouncementReply", AnnouncementReplySchema);
export default AnnouncementReply;
