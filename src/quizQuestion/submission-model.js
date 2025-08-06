import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const AnswerSchema = new Schema({
  question: {
    type: Schema.Types.ObjectId,
    ref: 'QuizQuestion',      // ← was 'Question' or 'Quiz' before
    required: true
  },
  selectedOption: { type: String, required: true },
  earnedPoints:   { type: Number, default: 0 },
  teacherFeedback:{ type: String, default: '' }
});

const QuizSubmissionSchema = new Schema({
  quiz: {
    type: Schema.Types.ObjectId,
    ref: 'QuizQuestion',      // ← must match your quiz‐model name
    required: true
  },
  student: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  answers:   { type: [AnswerSchema], default: [] },
  totalScore:{ type: Number, default: 0 },
  status:    { type: String, enum: ['in-progress','submitted'], default: 'in-progress' },
  submittedAt: Date
}, { timestamps: true });

// ensure one per student+quiz
QuizSubmissionSchema.index({ quiz:1, student:1 }, { unique: true });

export default model('QuizSubmission', QuizSubmissionSchema);
