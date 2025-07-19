import mongoose from "mongoose";

const semesterOrYearSchema = new mongoose.Schema({
  faculty: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Faculty",
    required: true,
  },
  semesterNumber: {
    type: Number,
    required: false,
    min: 1,
  },
  yearNumber: {
    type: Number,
    required: false,
    min: 1,
  },
  name: {
    type: String,
    trim: true,
    unique: true,
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
}, { timestamps: true });

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

// Auto-generate name/slug based on faculty and semester/year
semesterOrYearSchema.pre("save", async function (next) {
  const Faculty = mongoose.model("Faculty");
  const faculty = await Faculty.findById(this.faculty);
  if (!faculty) return next(new Error("Faculty not found"));
  const facultyCode = faculty.code.trim().toLowerCase();

  if (faculty.type === "semester") {
    this.name = `${this.semesterNumber}${getOrdinalSuffix(this.semesterNumber)} Semester ${facultyCode}`;
    this.slug = `${this.semesterNumber}_sem_${facultyCode}`;
  } else {
    this.name = `${this.yearNumber}${getOrdinalSuffix(this.yearNumber)} Year ${facultyCode}`;
    this.slug = `${this.yearNumber}_year_${facultyCode}`;
  }
  next();
});

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
