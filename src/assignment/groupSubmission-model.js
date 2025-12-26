import mongoose from "mongoose";
const { Schema } = mongoose;

// --- File Schema ---
const fileSchema = new Schema({
  url:           { type: String, required: true },
  originalname:  { type: String, required: true },
  filetype:      { type: String, required: true },
  extractedText: { type: String, default: '' },
}, { _id: false });

// --- Chunk Embedding Schema ---
const chunkEmbeddingSchema = new Schema({
  text:      { type: String, required: true },
  embedding: [{ type: Number, required: true }],
  lineNumber:{ type: Number, required: true },
}, { _id: false });

// --- Plagiarism Detail Schema ---
const plagiarismDetailSchema = new Schema({
  sourceType:     { type: String, enum: ['submission', 'reference'], required: true },
  sourceId:       { type: Schema.Types.ObjectId, required: true, refPath: 'plagiarismDetails.sourceType' },
  similarity:     { type: Number, required: true },
  matchedText:    { type: String, required: true },
  lineNumber:     { type: Number },
  matchedStudent: { type: Schema.Types.ObjectId, ref: 'User' },    // For matched submission
  matchedGroup:   { type: Schema.Types.ObjectId, ref: 'Group' },   // For matched group
}, { _id: false });

// --- Main Group Assignment Submission Schema ---
const groupAssignmentSubmissionSchema = new Schema({
  groupAssignmentId: { type: Schema.Types.ObjectId, ref: "GroupAssignment", required: true },
  groupId:           { type: Schema.Types.ObjectId, ref: "Group", required: true },
  submittedBy:       { type: Schema.Types.ObjectId, ref: "User", required: true },
  files:             [fileSchema],
  combinedText:      { type: String, default: '' },
  embedding:         [{ type: Number }],
  chunkEmbeddings:   [chunkEmbeddingSchema],

  isFlagged:         { type: Boolean, default: false },
  plagiarismPercentage: { type: Number, default: 0 },
  plagiarismDetails: [plagiarismDetailSchema],

  submittedAt:       { type: Date, default: Date.now },

  feedback:          { type: String },
  grade:             { type: Number, default: null },

  // <-- Add this line:
  status: { 
    type: String, 
    enum: ["draft", "submitted"], 
    default: "draft" 
  },
});

//  this is not working right now
export default mongoose.models.GroupAssignmentSubmission ||
  mongoose.model("GroupAssignmentSubmission", groupAssignmentSubmissionSchema);
