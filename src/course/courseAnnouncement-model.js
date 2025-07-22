import mongoose from "mongoose";
const { Schema } = mongoose;

const courseAnnouncementSchema = new Schema(
  {
    content: { type: String, required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
    images: [String],
    documents: [String],
    links: [String],
    youtubeLinks: [String],
    commentsDisabled: { type: Boolean, default: false },
    mutedStudents: [{ type: Schema.Types.ObjectId, ref: "User" }],
    visibleTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export default mongoose.model("CourseAnnouncement", courseAnnouncementSchema);
