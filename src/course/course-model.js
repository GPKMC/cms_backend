// models/course-model.js

import mongoose from 'mongoose';
const { Schema } = mongoose;
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
  semesterOrYear: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SemesterOrYear',
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: ['compulsory', 'elective'],
    trim: true,
    lowercase: true,
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
courseSchema.pre('remove', async function(next){
  if (this.semesterOrYear) {
    await mongoose.model('SemesterOrYear').findByIdAndUpdate(this.semesterOrYear, { $pull: { courses: this._id }});
  }
  next();
});
const Course = mongoose.model('Course', courseSchema);

export default Course;
