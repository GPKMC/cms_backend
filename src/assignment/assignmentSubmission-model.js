import mongoose from 'mongoose';
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, required: true },           // File location (S3, local, etc.)
  originalname: { type: String, required: true },  // Original filename
  filetype: { type: String, required: true },      // MIME type or extension (pdf, image/jpeg, docx, etc.)
  extractedText: { type: String, default: '' },    // Extracted text or OCR result
});

const plagiarismDetailSchema = new Schema({
  sourceType: { type: String, enum: ['submission', 'reference'], required: true },
  sourceId: { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
  similarity: { type: Number, required: true },    // Similarity score (0 to 1)
  matchedText: { type: String, required: true },   // Text snippet that matched
  lineNumber: { type: Number },                     // Line or chunk number in the submission text
}, { _id: false });

const submissionSchema = new Schema({
  assignment: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  files: [fileSchema],                              // Uploaded files + extracted text
  combinedText: { type: String, required: true },  // Combined text from all files
  embedding: [{ type: Number }],                    // Embedding vector for combinedText
  references: [{ type: Schema.Types.ObjectId, ref: 'Reference' }], // Linked references detected
  submittedAt: { type: Date, default: Date.now },
  grade: { type: Number, default: null },
  feedback: { type: String, default: '' },
  
  isFlagged: { type: Boolean, default: false },    // Plagiarism flag
  plagiarismPercentage: { type: Number, default: 0 }, // Max similarity % found

  plagiarismDetails: [plagiarismDetailSchema],     // Detailed per-chunk plagiarism matches
});

export default mongoose.model('Submission', submissionSchema);
