import mongoose from "mongoose";

const AttendanceSessionSchema = new mongoose.Schema(
  {
    courseInstance: { type: mongoose.Types.ObjectId, ref: "CourseInstance", required: true, index: true },
    teacher:        { type: mongoose.Types.ObjectId, ref: "User",          required: true, index: true },

    startedAt: { type: Date, default: Date.now },
    isClosed:  { type: Boolean, default: false },
    closedAt:  { type: Date },

    // QR mechanics
    rotating:      { type: Boolean, default: true },
    sessionSecret: { type: String, required: true }, // per-session JWT secret
  },
  { timestamps: true }
);

AttendanceSessionSchema.index({ courseInstance: 1, startedAt: -1 });
export default mongoose.model("AttendanceSession", AttendanceSessionSchema);
