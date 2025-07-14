import mongoose from "mongoose";

const materialSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },

  description: {
    type: String,
    trim: true,
  },

  fileUrl: {
    type: String,
    required: true, // could be S3 link, PDF, etc.
  },

  type: {
    type: String,
    enum: ["note", "assignment", "slide", "other"],
    default: "note",
  },

  teacherAssignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TeacherAssignment",
    required: true,
  },

  uploadedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

const Material = mongoose.model("Material", materialSchema);
export default Material;
