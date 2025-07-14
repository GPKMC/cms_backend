import mongoose from "mongoose";

const teacherSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  password: { type: String, required: true },

  googleId: { type: String, default: null },
 phone : { type: String, trim: true },
  isActive: { type: Boolean, default: true },

  isVerified: { type: Boolean, default: false },
}, { timestamps: true });

const Teacher = mongoose.model("Teacher", teacherSchema);
export default Teacher;
