import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
  },
  semester: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SemesterOrYear',
    required: true,
  },
  slug: {
    type: String,
    unique: true,
    index: true,
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
}, { timestamps: true });

// Generate slug from name and code before saving
courseSchema.pre('save', function(next) {
  if (!this.slug && this.name && this.code) {
    this.slug = `${this.code.toLowerCase()}-${this.name.toLowerCase().replace(/\s+/g, '-')}`;
  }
  next();
});

// Post-save hook: add this course ID to the semester's courses array if not already there
courseSchema.post('save', async function(doc, next) {
  try {
    if (doc.semester) {
      await mongoose.model('SemesterOrYear').findByIdAndUpdate(doc.semester, {
        $addToSet: { courses: doc._id },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
});

const Course = mongoose.model('Course', courseSchema);
export default Course;
