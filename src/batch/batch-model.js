import mongoose from "mongoose";

const BatchSchema = new mongoose.Schema({
  batchname: {
    type: String,
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
    // Fetch faculty to get the code
    const Faculty = mongoose.model('Faculty');
    const facultyDoc = await Faculty.findById(this.faculty);

    if (!facultyDoc || !facultyDoc.code) {
      return next(new Error('Faculty code not found for batchname generation'));
    }

    const facultyCode = facultyDoc.code.trim();

    // Generate batchname in format facultyCode_startYear, e.g., BCA_2025
    this.batchname = `${facultyCode}_${this.startYear}`;

    // Generate slug: lowercase, kebab-case (e.g., bca-2025)
    this.slug = `${facultyCode.toLowerCase()}-${this.startYear}`;

    next();
  } catch (error) {
    next(error);
  }
});

const Batch = mongoose.model('Batch', BatchSchema);
export default Batch;
