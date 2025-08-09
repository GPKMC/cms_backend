import mongoose from "mongoose";

const AttendanceRecordSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Types.ObjectId, ref: "AttendanceSession", required: true, index: true },
    student: { type: mongoose.Types.ObjectId, ref: "User", required: true, index: true },

    status: { type: String, enum: ["present", "absent", "late"], default: "present" },
    markedAt: { type: Date, default: Date.now },
    via: { type: String, enum: ["qr", "manual"], required: true },

    // optional metadata for anti-cheat / audit
    meta: {
      ip: String,
      ua: String,
      deviceId: String,
      ssid: String,
      location: {
        lat: Number,
        lng: Number,
        accuracy: Number
      }
    }
  },
  { timestamps: true }
);

// ensure only one record per (session, student)
AttendanceRecordSchema.index({ session: 1, student: 1 }, { unique: true });

export default mongoose.model("AttendanceRecord", AttendanceRecordSchema);
