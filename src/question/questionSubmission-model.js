import mongoose from 'mongoose';
const { Schema } = mongoose;

// --- Chunk Embedding Schema ---
const chunkEmbeddingSchema = new Schema({
  text:      { type: String, required: true },
  embedding: [{ type: Number, required: true }],
  lineNumber:{ type: Number, required: true },
}, { _id: false });

// --- Plagiarism Detail Schema ---
const plagiarismDetailSchema = new Schema({
  sourceType:      { type: String, enum: ['submission', 'reference'], required: true },
  sourceId:        { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
  similarity:      { type: Number, required: true },
  matchedText:     { type: String, required: true },
  lineNumber:      { type: Number },
  matchedStudentId:{ type: Schema.Types.ObjectId, ref: 'User' },   
  matchedGroupId:  { type: Schema.Types.ObjectId, ref: 'Group' }
}, { _id: false });

// --- Main Question Submission Schema ---
const questionSubmissionSchema = new Schema({
  question:         { type: Schema.Types.ObjectId, ref: 'QuestionModel', required: true },
  student:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
  answerText:       { type: String, required: true },           
  chunkEmbeddings:  [chunkEmbeddingSchema],
  embedding:        [{ type: Number }],
  isFlagged:        { type: Boolean, default: false },
  plagiarismPercentage: { type: Number, default: 0 },
  plagiarismDetails: [plagiarismDetailSchema],
  submittedAt:      { type: Date, default: Date.now },
  grade:            { type: Number, default: null },
  feedback:         { type: String, default: '' },
  status:           { type: String, enum: ["draft", "submitted"], default: "draft" }
});


export default mongoose.models.QuestionSubmission ||
  mongoose.model('QuestionSubmission', questionSubmissionSchema);
