import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {                  // e.g., CS101
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
  },
  faculty: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Faculty',
    required: true,
  },
  semesters: [{            // Which semesters this course belongs to (can be multiple)
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Semester',
  }],
  batches: [{              // Which batches are taking this course
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
  }],
  materials: [{            // References to study materials for this course
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Material',
  }],
  assignments: [{          // References to assignments for this course
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
  }],
  attendanceRecords: [{    // References to attendance records for this course
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance',
  }],
  grades: [{               // References to grade records for this course
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grade',
  }],
}, { timestamps: true });

const Course = mongoose.model('Course', courseSchema);
export default Course;
