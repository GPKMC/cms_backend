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
    trim: true,
  },
  semesterOrYear: { // use "semesterOrYear" for clarity!
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SemesterOrYear',
    required: true,
  },
  slug: {
    type: String,
    unique: true,
    index: true,
  },
}, { timestamps: true });

courseSchema.pre('save', function(next) {
  if (!this.slug && this.name && this.code) {
    this.slug = `${this.code.trim().toLowerCase()}-${this.name.trim().toLowerCase().replace(/\s+/g, '-')}`;
  }
  next();
});

// Optionally auto-add to SemesterOrYear.courses (still fine)
courseSchema.post('save', async function(doc, next) {
  try {
    if (doc.semesterOrYear) {
      await mongoose.model('SemesterOrYear').findByIdAndUpdate(doc.semesterOrYear, {
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
