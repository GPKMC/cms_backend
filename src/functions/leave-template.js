import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * One document per (role,type) combo.
 * role: "teacher" | "student"
 * type: "sick" | "emergency" | "function" | "puja" | "personal" | "other"
 */
const LeaveEmailTemplateSchema = new Schema(
  {
    role: { type: String, enum: ["teacher", "student"], required: true },
    type: { type: String, required: true },
    subject: { type: String, required: true },           // e.g., "[Leave Request][Teacher] {date} – {type} — {name}"
    html: { type: String, required: true },              // HTML body with {placeholders}
    text: { type: String, required: true },              // Plain text fallback
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

LeaveEmailTemplateSchema.index({ role: 1, type: 1 }, { unique: true });

export default mongoose.model("LeaveEmailTemplate", LeaveEmailTemplateSchema);
