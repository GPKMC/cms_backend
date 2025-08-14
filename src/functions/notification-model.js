import mongoose from "mongoose";
const { Schema } = mongoose;

const notificationSchema = new Schema({
  courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
  type: {
    type: String,
    enum: [
      "material",
      "announcement",
      "assignment",
      "group-assignment",
      "quiz",
      "comment",
      "question",
      "assignment-submission",
      "group-assignment-submission",
      "question-submission"
    ],
    required: true
  },
  refId: { type: Schema.Types.ObjectId, required: true }, // ID of related item

  title: { type: String }, 
  message: { type: String },

  // --- New: Who submitted ---
  submittedByUser: { type: Schema.Types.ObjectId, ref: "User" }, // For individual submissions
  submittedByGroup: { type: Schema.Types.ObjectId, ref: "Group" }, // For group submissions

  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  recipients: [{ type: Schema.Types.ObjectId, ref: "User" }],
  readBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  archivedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  archived: { type: Boolean, default: false }
});

export default mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
