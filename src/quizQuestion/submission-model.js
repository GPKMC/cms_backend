import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// Each answer within a submission
const AnswerSchema = new Schema({
  question: {
    type: Schema.Types.ObjectId,
    ref: 'QuizQuestion',
    required: true
  },
  selectedOption: {
    type: Schema.Types.ObjectId,
    ref: 'QuizQuestion.questions.options'
  },
  textAnswer: { type: String },
  earnedPoints: { type: Number, default: 0 },
  feedback: { type: String, default: '' }
});

// Submission document for a student
const SubmissionSchema = new Schema({
  quiz: {
    type: Schema.Types.ObjectId,
    ref: 'QuizQuestion',
    required: true
  },
  student: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  answers:    { type: [AnswerSchema], default: [] },
  totalScore: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['in-progress','submitted'],
    default: 'in-progress'
  },
  submittedAt: { type: Date }
}, {
  timestamps: true
});

export default model('Submission', SubmissionSchema);
