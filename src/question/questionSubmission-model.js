import mongoose from 'mongoose';
const { Schema } = mongoose;

const plagiarismDetailSchema = new Schema({
  sourceType: { type: String, enum: ['submission', 'reference'], required: true },
  sourceId:   { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
  similarity: { type: Number, required: true },
  matchedText: { type: String, required: true },
  lineNumber: { type: Number },
  matchedStudentId: { type: Schema.Types.ObjectId, ref: 'User' },   // <-- NEW
  matchedGroupId:   { type: Schema.Types.ObjectId, ref: 'Group' }   // <-- NEW, optional
}, { _id: false });

const questionSubmissionSchema = new Schema({
  question: { type: Schema.Types.ObjectId, ref: 'QuestionModel', required: true },
  student:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  answerText: { type: String, required: true },           
  embedding: [{ type: Number }],                          
  isFlagged: { type: Boolean, default: false },           
  plagiarismPercentage: { type: Number, default: 0 },     
  plagiarismDetails: [plagiarismDetailSchema],
  submittedAt: { type: Date, default: Date.now },
  grade: { type: Number, default: null },
  feedback: { type: String, default: '' }
});

export default mongoose.models.QuestionSubmission ||
  mongoose.model('QuestionSubmission', questionSubmissionSchema);
