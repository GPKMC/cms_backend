import mongoose from "mongoose";

const teacherAssignmentSchema = new mongoose.Schema({
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Teacher",
    required: true,
  },

  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
    required: true,
  },

  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course",
    required: true,
  },

  semesterOrYear: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SemesterOrYear",
    required: true,
  },

  assignedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

const TeacherAssignment = mongoose.model("TeacherAssignment", teacherAssignmentSchema);
export default TeacherAssignment;
