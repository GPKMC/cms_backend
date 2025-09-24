import mongoose from "mongoose";
const { Schema } = mongoose;

// Store date as YYYY-MM-DD to avoid timezone bugs.
const LeaveRequestSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["teacher", "student"], required: true, default: "teacher" },

    leaveDate: { type: String, required: true }, // "YYYY-MM-DD" (Asia/Kathmandu)
    dayPart: { type: String, enum: ["full", "first_half", "second_half"], default: "full" },

    type: {
      type: String,
      enum: ["sick", "emergency", "function", "puja", "personal", "other"],
      required: true,
    },
    reason: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },

    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    rejectionReason: { type: String },

    // Optional: file attachments later (doctor note, etc.)
    // attachments: [{ url: String, originalname: String }]
  },
  { timestamps: true }
);

// Helpful indexes
LeaveRequestSchema.index({ user: 1, leaveDate: 1, status: 1 });

export default mongoose.model("LeaveRequest", LeaveRequestSchema);
