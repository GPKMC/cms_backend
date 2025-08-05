import mongoose from 'mongoose';
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, required: true },           // File location (S3, local, etc.)
  originalname: { type: String, required: true },  // Original filename
  filetype: { type: String, required: true },      // MIME type or extension (pdf, image/jpeg, docx, etc.)
  extractedText: { type: String, default: '' },    // Extracted text or OCR result
});

// New schema for chunk (line) embeddings
const chunkEmbeddingSchema = new Schema({
  text: { type: String, required: true },            // The chunk text (line or paragraph)
  embedding: [{ type: Number, required: true }],     // Embedding vector for this chunk
  lineNumber: { type: Number, required: true },      // Line or chunk index
}, { _id: false });

const plagiarismDetailSchema = new Schema({
  sourceType:    { type: String, enum: ['submission', 'reference'], required: true },
  sourceId:      { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
  similarity:    { type: Number, required: true },
  matchedText:   { type: String, required: true },
  lineNumber:    { type: Number },
  matchedStudent:{ type: Schema.Types.ObjectId, ref: 'User' },    // Student whose submission was matched
  matchedGroup:  { type: Schema.Types.ObjectId, ref: 'Group' }    // (optional) Group whose submission was matched
}, { _id: false });

const submissionSchema = new Schema({
  assignment:    { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  student:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  files:         [fileSchema],
  combinedText:  { type: String, required: true },
  embedding:     [{ type: Number }],       // whole text embedding (optional)
  chunkEmbeddings: [chunkEmbeddingSchema], // line-level embeddings (new)

  references:    [{ type: Schema.Types.ObjectId, ref: 'Reference' }],
  submittedAt:   { type: Date, default: Date.now },
  grade:         { type: Number, default: null },
  feedback:      { type: String, default: '' },
  isFlagged:     { type: Boolean, default: false },
  plagiarismPercentage: { type: Number, default: 0 },
  status:        { type: String, enum: ['draft', 'submitted'], default: 'draft' },

  plagiarismDetails: [plagiarismDetailSchema]
});

export default mongoose.models.Submission || mongoose.model('Submission', submissionSchema);
