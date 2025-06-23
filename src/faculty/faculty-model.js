import mongoose from "mongoose";

const facultySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true, // Example: "BCA", "BBS", "BSW"
  },
  code: {
    type: String,
    required: true,
    unique: true, // Example: "BCA", "BBS"
  },
  type: {
    type: String,
    enum: ['semester', 'yearly'],
    required: true,
  },
  totalSemestersOrYears: {
    type: Number,
    required: true, // 8 for BCA (semester), 4 for BBS (yearly)
  },
  description: {
    type: String,
    trim: true,
  },
  slug: {
    type: String,
    unique: true,
  },
}, { timestamps: true });

// Generate slug before saving
facultySchema.pre('save', function (next) {
  if (!this.slug && this.name && this.code) {
    this.slug = `${this.code.trim().toLowerCase()}-${this.name.trim().toLowerCase().replace(/\s+/g, '-')}`;
  }
  next();
});

const Faculty = mongoose.model('Faculty', facultySchema);
export default Faculty;
