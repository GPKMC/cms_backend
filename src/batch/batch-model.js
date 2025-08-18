import mongoose from "mongoose";

const BatchSchema = new mongoose.Schema({
  batchname: {
    type: String,
    required: true,
    trim: true,
  },
  faculty: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Faculty',
    required: true,
  },
  startYear: {
    type: Number,
    required: true,
  },
  endYear: Number,
  isCompleted: {
    type: Boolean,
    default: false,
  },
  currentSemesterOrYear: {
    type: Number,
    required: true,
  },
  slug: {
    type: String,
    unique: true,
  },
}, { timestamps: true });

BatchSchema.pre('save', async function (next) {
  try {
    // Generate batchname if missing
    if ((!this.batchname || this.batchname.trim() === '') && this.faculty && this.startYear) {
      const Faculty = mongoose.model('Faculty');
      const facultyDoc = await Faculty.findById(this.faculty);

      if (facultyDoc && facultyDoc.code) {
        this.batchname = `${facultyDoc.code.trim()} ${this.startYear}`;
      } else {
        return next(new Error('Faculty code not found for batchname generation'));
      }
    }
    // Generate slug
    if (!this.slug && this.batchname && this.startYear) {
      this.slug = `${this.startYear}-${this.batchname.toLowerCase().replace(/\s+/g, '-')}`;
    }
    next();
  } catch (error) {
    next(error);
  }
});
BatchSchema.index({ faculty: 1, startYear: 1 }, { unique: true });

const Batch = mongoose.model('Batch', BatchSchema);
export default Batch;
