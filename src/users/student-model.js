import mongoose from "mongoose";

const studentSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true,
  },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  password: {
    type: String,
    required: true,
  },

  googleId: {
    type: String,
    default: null,
  },

  contactNumber: {
    type: String,
    trim: true,
  },

  profileImage: {
    type: String,
    default: null,
  },

  isActive: {
    type: Boolean,
    default: true,
  },

  isVerified: {
    type: Boolean,
    default: false,
  },

  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
    required: true,
  },
}, { timestamps: true });

const Student = mongoose.model("Student", studentSchema);
export default Student;
