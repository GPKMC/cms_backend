// models/SemesterOrYear.js
import mongoose from "mongoose";

const semesterOrYearSchema = new mongoose.Schema(
  {
    faculty: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Faculty",
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
    courses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
      },
    ],
    slug: {
      type: String,
      unique: true,
    },
  },
  { timestamps: true }
);

// Dynamic validation logic before saving:
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

// Generate name and slug before saving:
semesterOrYearSchema.pre("save", async function (next) {
  if (!this.name || !this.slug) {
    const Faculty = mongoose.model("Faculty");
    const faculty = await Faculty.findById(this.faculty);

    if (faculty) {
      const facultyCode = faculty.code.trim();
      if (faculty.type === "semester") {
        // e.g. "BCA 2nd Semester"
        this.name = `${facultyCode} ${this.semesterNumber}${getOrdinalSuffix(this.semesterNumber)} Semester`;
        this.slug = `${facultyCode.toLowerCase().replace(/\s+/g, "_")}_${this.semesterNumber}_sem`;
      } else {
        // e.g. "BBS 3rd Year"
        this.name = `${facultyCode} ${this.yearNumber}${getOrdinalSuffix(this.yearNumber)} Year`;
        this.slug = `${facultyCode.toLowerCase().replace(/\s+/g, "_")}_${this.yearNumber}_year`;
      }
    }
  }

  next();
});

// Helper function to get ordinal suffix like "st", "nd", "rd", "th"
function getOrdinalSuffix(n) {
  if (typeof n !== "number") return "";
  const j = n % 10,
    k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

const SemesterOrYear = mongoose.model("SemesterOrYear", semesterOrYearSchema);
export default SemesterOrYear;
