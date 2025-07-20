import mongoose from "mongoose";

const courseAnnouncementSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    courseInstance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CourseInstance",
      required: true,
    },
    attachments: [
      {
        type: String,
      },
    ],
    links: [
      {
        type: String,
      },
    ],
    commentsDisabled: {
      type: Boolean,
      default: false,
    },
    mutedStudents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.models.CourseAnnouncement ||
  mongoose.model("CourseAnnouncement", courseAnnouncementSchema);
