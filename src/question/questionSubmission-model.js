import mongoose from 'mongoose';
const { Schema } = mongoose;

const questionSubmissionSchema = new Schema({
  question: { type: Schema.Types.ObjectId, ref: 'QuestionModel', required: true },
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  answerText: { type: String, required: true },           // Student's typed answer
  embedding: [{ type: Number }],                          // Embedding of answerText for plagiarism check
  isFlagged: { type: Boolean, default: false },           // Plagiarism flag
  plagiarismPercentage: { type: Number, default: 0 },     // Max plagiarism percentage found
  plagiarismDetails: [
    {
      sourceType: { type: String, enum: ['submission', 'reference'], required: true },
      sourceId: { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
      similarity: { type: Number, required: true },
      matchedText: { type: String, required: true },
      lineNumber: { type: Number },
    }
  ],
  submittedAt: { type: Date, default: Date.now },
  grade: { type: Number, default: null },
  feedback: { type: String, default: '' }
});

export default mongoose.models.QuestionSubmission || mongoose.model('QuestionSubmission', questionSubmissionSchema);
