import mongoose from "mongoose";
const { Schema } = mongoose;

const notificationSchema = new Schema({
  courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
  type: {
    type: String,
    enum: [
      "material", "announcement", "assignment", "group-assignment", "quiz", "comment","question",
    ],
    required: true
  },
  refId: { type: Schema.Types.ObjectId, required: true }, // ID of the related item
  title: { type: String }, // Short description
  message: { type: String }, // Body/message
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  recipients: [{ type: Schema.Types.ObjectId, ref: "User" }], // who should see
  readBy: [{ type: Schema.Types.ObjectId, ref: "User" }], // who has read
  // Optionally: add more metadata fields
  archivedBy: [{ type: Schema.Types.ObjectId, ref: "User" }], // Array: who has archived
  // OR
  archived: { type: Boolean, default: false },
});

export default mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
