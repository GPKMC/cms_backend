import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },

  email: { type: String, required: true, unique: true, lowercase: true, trim: true },

  // Password REQUIRED for all users
  password: { type: String, required: true },

  // Google OAuth ID (optional, only used when user logs in via Google)
  googleId: { type: String, default: null },

  role: {
    type: String,
    enum: ["student", "teacher", "admin", "superadmin"],
    default: "student",
    required: true,
  },

  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },

}, { timestamps: true });

const User = mongoose.model("User", UserSchema);
export default User;
