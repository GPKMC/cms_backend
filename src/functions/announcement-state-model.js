import mongoose from "mongoose";
const { Schema, Types } = mongoose;

const AnnouncementStateSchema = new Schema(
  {
    announcement: { type: Types.ObjectId, ref: "Announcement", required: true, index: true },
    user:         { type: Types.ObjectId, ref: "User", required: true, index: true },
    readAt:       { type: Date },
    archived:     { type: Boolean, default: false },
    archivedAt:   { type: Date },
  },
  { timestamps: true }
);

AnnouncementStateSchema.index({ announcement: 1, user: 1 }, { unique: true });

const AnnouncementState =
  mongoose.models.AnnouncementState ||
  mongoose.model("AnnouncementState", AnnouncementStateSchema);

export default AnnouncementState;
