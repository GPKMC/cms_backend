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
    required: true, // Every batch MUST belong to a faculty
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
    required: true, // Example: 5 (5th semester or 3rd year depending on faculty.type)
  },
  slug: {
    type: String,
    unique: true,
  },
}, { timestamps: true });

BatchSchema.pre('save', function (next) {
  if (!this.slug && this.batchname && this.startYear) {
    this.slug = `${this.startYear}-${this.batchname.toLowerCase().replace(/\s+/g, '-')}`;
  }
  next();
});
BatchSchema.pre('save', async function (next) {
  try {
    // Only generate if batchname is missing or empty
    if ((!this.batchname || this.batchname.trim() === '') && this.faculty && this.startYear) {
      // Fetch faculty document to get the code
      const Faculty = mongoose.model('Faculty');
      const facultyDoc = await Faculty.findById(this.faculty);

      if (facultyDoc && facultyDoc.code) {
        this.batchname = `${facultyDoc.code.trim()} ${this.startYear}`;
      } else {
        // If faculty or code missing, fallback or throw error
        return next(new Error('Faculty code not found for batchname generation'));
      }
    }

    // Generate slug based on batchname and startYear (optional: keep your current slug generation)
    if (!this.slug && this.batchname && this.startYear) {
      this.slug = `${this.startYear}-${this.batchname.toLowerCase().replace(/\s+/g, '-')}`;
    }

    next();
  } catch (error) {
    next(error);
  }
});

const Batch = mongoose.model('Batch', BatchSchema);
export default Batch;
