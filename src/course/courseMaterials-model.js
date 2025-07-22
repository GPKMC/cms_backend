import mongoose from "mongoose";
const { Schema } = mongoose;

const courseMaterialSchema = new Schema(
  {
    title: { type: String, required: true }, // <-- Add this line for the title!
    content: { type: String, required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
    topic: { type: Schema.Types.ObjectId, ref: "Topic"},
    media: [String],          // Stores both image & video URLs
    documents: [String],      // pdf, ppt, doc, etc.
    links: [String],          // Any external links
    youtubeLinks: [String],   // For YouTube embeds
    commentsDisabled: { type: Boolean, default: false },
    mutedStudents: [{ type: Schema.Types.ObjectId, ref: "User" }],
    visibleTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export default mongoose.model("CourseMaterial", courseMaterialSchema);

