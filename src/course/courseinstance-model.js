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
  questions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question',
  }],
  quiz: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',  
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
    commentingDisabled: {
      type: Boolean,
      default: false, // 🔒 disables comments globally for this course
    },

    mutedStudents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User", // 🔇 student-level mute
      },
    ],
}, { timestamps: true });

// Enforce unique batch+course+teacher if needed (or just batch+course)
courseInstanceSchema.index({ batch: 1, course: 1 }, { unique: true });
courseInstanceSchema.pre('validate', async function(next){
  try {
    const User = mongoose.model('User');
    const Course = mongoose.model('Course');
    const SemesterOrYear = mongoose.model('SemesterOrYear');
    const Faculty = mongoose.model('Faculty');
    const Batch = mongoose.model('Batch');

    // teacher must be a teacher
    const t = await User.findById(this.teacher).select('role').lean();
    if (!t || t.role !== 'teacher') return next(new Error('Assigned teacher must have role="teacher"'));

    // batch & course must be of same faculty
    const [course, batch] = await Promise.all([
      Course.findById(this.course).populate({ path: 'semesterOrYear', select:'faculty' }).lean(),
      Batch.findById(this.batch).select('faculty').lean()
    ]);
    if (!course || !batch) return next(new Error('Invalid batch or course'));
    const facFromCourse = course?.semesterOrYear?.faculty?.toString();
    const facFromBatch = batch?.faculty?.toString();
    if (!facFromCourse || !facFromBatch || facFromCourse !== facFromBatch) {
      return next(new Error('Batch and Course must belong to the same Faculty'));
    }
    next();
  } catch (e) { next(e); }
});
const CourseInstance = mongoose.model('CourseInstance', courseInstanceSchema);
export default CourseInstance;
