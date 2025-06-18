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
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
}, { timestamps: true });

BatchSchema.pre('save', function (next) {
  if (!this.slug && this.batchname && this.startYear) {
    this.slug = `${this.startYear}-${this.batchname.toLowerCase().replace(/\s+/g, '-')}`;
  }
  next();
});

const Batch = mongoose.model('Batch', BatchSchema);
export default Batch;
