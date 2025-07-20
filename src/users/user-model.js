import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },

  email: { type: String, required: true, unique: true, lowercase: true, trim: true },

  password: { type: String, required: true },

  googleId: { type: String, default: null },

  role: {
    type: String,
    enum: ["student", "teacher", "admin", "superadmin"],
    default: "student",
    required: true,
  },

  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },

  // Add batch reference (only valid if role === "student")
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
    required: function () {
      // Required only if role is student
      return this.role === "student";
    },
  },

}, { timestamps: true });

const User = mongoose.model("User", UserSchema);
export default User;
