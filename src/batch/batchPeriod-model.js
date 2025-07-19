import mongoose from "mongoose";

const batchPeriodSchema = new mongoose.Schema({
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
    required: true,
  },
  semesterOrYear: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SemesterOrYear",
    required: true,
  },
  startDate: Date,
  endDate: Date,
  status: {
    type: String,
    enum: ["not_started", "ongoing", "completed"],
    default: "not_started",
  },
  description: String,
  slug: { type: String, unique: true },
}, { timestamps: true });

// Unique index
batchPeriodSchema.index(
  { batch: 1, semesterOrYear: 1 },
  { unique: true }
);

// Slug generation
batchPeriodSchema.pre('save', function (next) {
  if (!this.slug && this.batch && this.semesterOrYear) {
    this.slug = `${this.batch.toString()}_${this.semesterOrYear.toString()}`;
  }
  next();
});

const BatchPeriod = mongoose.model("BatchPeriod", batchPeriodSchema);
export default BatchPeriod;
