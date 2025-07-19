import mongoose from 'mongoose';

const courseInstanceSchema = new mongoose.Schema({
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  teacher: { // Just ONE teacher, from User collection
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  materials: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Material',
  }],
  assignments: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
  }],
  attendanceRecords: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance',
  }],
  grades: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grade',
  }],
    isActive: { type: Boolean, 
        // default: true 
    },
}, { timestamps: true });

// Enforce unique batch+course+teacher if needed (or just batch+course)
courseInstanceSchema.index({ batch: 1, course: 1 }, { unique: true });

const CourseInstance = mongoose.model('CourseInstance', courseInstanceSchema);
export default CourseInstance;
