// user-model.js
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },

  // Set on first successful Google link
  googleId: { type: String, default: null },

  role: {
    type: String,
    enum: ["student", "teacher", "admin", "superadmin"],
    default: "student",
    required: true,
  },

  isActive:   { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },

  // Only for students
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
    required: function () { return this.role === "student"; },
  },
}, { timestamps: true });

// One Google account ↔ one user (only when googleId is set)
UserSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: "string" } } }
);

const User = mongoose.model("User", UserSchema);
export default User;
