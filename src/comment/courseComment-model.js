import mongoose from "mongoose";

const courseCommentSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    courseInstance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CourseInstance",
      required: true,
    },
    type: {
      type: String,
      enum: ["announcement", "material", "assignment","question"],
      required: true,
    },
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true, // references announcement/material/assignment _id
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.models.CourseComment ||
  mongoose.model("CourseComment", courseCommentSchema);
