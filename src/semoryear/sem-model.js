import mongoose from "mongoose";

const semesterOrYearSchema = new mongoose.Schema(
  {
    faculty: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Faculty",
      required: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    semesterNumber: {
      type: Number,
      required: false, // required if faculty.type === "semester"
      min: 1,
    },
    yearNumber: {
      type: Number,
      required: false, // required if faculty.type === "yearly"
      min: 1,
    },
    name: {
      type: String,
      trim: true,
      unique: true,  // name should be unique for clarity
    },
    description: {
      type: String,
      trim: true,
    },
    courses: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
    }],
    slug: {
      type: String,
      unique: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["not_started", "ongoing", "completed"],
      default: "not_started",
    },
  },
  { timestamps: true }
);

// Validation before save
semesterOrYearSchema.pre("validate", async function (next) {
  const Faculty = mongoose.model("Faculty");
  const faculty = await Faculty.findById(this.faculty);

  if (!faculty) {
    return next(new Error("Faculty not found"));
  }

  if (faculty.type === "semester" && !this.semesterNumber) {
    return next(new Error("semesterNumber is required for semester-based faculties."));
  }

  if (faculty.type === "yearly" && !this.yearNumber) {
    return next(new Error("yearNumber is required for yearly faculties."));
  }

  next();
});

// Generate name, slug, and dates before save
semesterOrYearSchema.pre("save", async function (next) {
  const Faculty = mongoose.model("Faculty");
  const Batch = mongoose.model("Batch");
  const faculty = await Faculty.findById(this.faculty);
  const batch = await Batch.findById(this.batch);
  if (!faculty || !batch) return next(new Error("Faculty or Batch not found"));

  const facultyCode = faculty.code.trim().toLowerCase();

  if (faculty.type === "semester") {
    this.name = `${batch.startYear} ${this.semesterNumber}${getOrdinalSuffix(this.semesterNumber)} Semester ${facultyCode}`;
    this.slug = `${batch.startYear}_${this.semesterNumber}_sem_${facultyCode}`;
  } else {
    this.name = `${batch.startYear} ${this.yearNumber}${getOrdinalSuffix(this.yearNumber)} Year ${facultyCode}`;
    this.slug = `${batch.startYear}_${this.yearNumber}_year_${facultyCode}`;
  }

  if (this.startDate) {
    const durationMonths = faculty.type === "semester" ? 6 : 12;
    const calculatedEndDate = new Date(this.startDate);
    calculatedEndDate.setMonth(calculatedEndDate.getMonth() + durationMonths);
    this.endDate = calculatedEndDate;

    console.log("Start Date:", this.startDate);
    console.log("Calculated End Date:", this.endDate);
  }

  next();
});




// Helper function to get ordinal suffix for numbers (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  if (typeof n !== "number") return "";
  const j = n % 10, k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

const SemesterOrYear = mongoose.model("SemesterOrYear", semesterOrYearSchema);
export default SemesterOrYear;
