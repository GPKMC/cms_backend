import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// Sub‐schema for MCQ options
const OptionSchema = new Schema({
  text: { type: String, required: true }
});

// Sub‐schema for questions
const QuestionSchema = new Schema({
  text:         { type: String, required: true },
  type:            { type: String, enum: ['mcq'], default: 'mcq' },
  points:       { type: Number, default: 0 },
  options:      { type: [OptionSchema], default: [] },
  correctOption: { type: String }, 
  feedbackCorrect:   { type: String, default: '' },
  feedbackIncorrect: { type: String, default: '' }
});

// Top‐level quiz schema
const QuizQuestionSchema = new Schema({
  title:          { type: String, required: true },
  description:    { type: String, default: '' },
  courseInstance: { type: Schema.Types.ObjectId, ref: 'CourseInstance', required: true },
  postedBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: Schema.Types.ObjectId, ref: "Topic" },
  dueDate:        { type: Date },
  published:      { type: Boolean, default: false },
  questions:      { type: [QuestionSchema], default: [] }
}, {
  timestamps: true
});

export default model('QuizQuestion', QuizQuestionSchema);
