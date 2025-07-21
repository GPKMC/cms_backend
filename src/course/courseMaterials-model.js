import mongoose from "mongoose";
const { Schema } = mongoose;

const fileSchema = new Schema({
  filename: { type: String, required: true },
  url: { type: String, required: true }, // S3 or local storage path
  mimetype: { type: String, required: true },
  size: { type: Number }, // in bytes
  uploadedAt: { type: Date, default: Date.now },
});

const linkSchema = new Schema({
  url: { type: String, required: true },
  title: { type: String }, // Optional, e.g. "YouTube Video", "Reference"
  type: { type: String }, // e.g., "youtube", "resource", "documentation"
});

const courseMaterialSchema = new Schema(
  {
    content: { type: String, required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
    files: [fileSchema], // Supports any file: ppt, pdf, doc, csv, etc.
    links: [linkSchema], // Supports any link (including YouTube, Vimeo, etc.)
    images: [String], // Optional: for quick image uploads (e.g., screenshot URLs)
    commentsDisabled: { type: Boolean, default: false },
    mutedStudents: [{ type: Schema.Types.ObjectId, ref: "User" }],
    visibleTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export default mongoose.model("CourseMaterial", courseMaterialSchema);
