import mongoose from "mongoose";

const SemesterSchema = new mongoose.Schema({
  faculty: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Faculty",
    required: true,
  },
  semesterNumber: {
    type: Number,
    required: true,
    min: 1,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  courses: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course", // Assuming you have a Course model for specific subjects
    },
  ],
  slug: {
    type: String,
    unique: true,
  }
},
{ timestamps: true });

// Generate slug before saving: "facultyname-semesterNumber"
SemesterSchema.pre("save", async function (next) {
  if (!this.slug && this.faculty && this.semesterNumber) {
    const Faculty = mongoose.model("Faculty");
    const faculty = await Faculty.findById(this.faculty);
    if (faculty) {
      const formatted = faculty.name.toLowerCase().replace(/\s+/g, "-");
      this.slug = `${formatted}-sem-${this.semesterNumber}`;
    }
  }
  next();
});

const Semester = mongoose.model("Semester", SemesterSchema);
export default Semester;
