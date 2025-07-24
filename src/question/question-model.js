import mongoose from 'mongoose';
const { Schema } = mongoose;

const QuestionSchema = new Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, // Teacher
  courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },
  topic: { type: Schema.Types.ObjectId, ref: "Topic" },
 documents: [{
  url: String,
  originalname: String,
}],
media: [{
  url: String,
  originalname: String,
}],    
  links: [String],          // Any external links
  youtubeLinks: [String],   // YouTube embed links
  commentsDisabled: { type: Boolean, default: false },
  mutedStudents: [{ type: Schema.Types.ObjectId, ref: "User" }],
  visibleTo: [{ type: Schema.Types.ObjectId, ref: "User" }], // Restrict to users
  dueDate: { type: Date, required: true },
  points: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// --- Correct pre-save hook ---
QuestionSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.QuestionModel || mongoose.model('QuestionModel', QuestionSchema);
