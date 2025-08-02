import mongoose from "mongoose";
const { Schema } = mongoose;

// Submission plagiarism match schema
const plagiarismMatchSchema = new Schema({
  type: { type: String, enum: ['submission', 'reference'], required: true },
  referenceId: { type: Schema.Types.ObjectId, ref: 'Reference' },
  studentId: { type: Schema.Types.ObjectId, ref: 'User' },
  similarity: { type: Number, required: true },
  matchedText: { type: String, required: true },
  lineNumber: Number,
  startCharIndex: Number,
  endCharIndex: Number
}, { _id: false });

// Main submission schema
const groupAssignmentSubmissionSchema = new Schema({
  groupAssignmentId: { type: Schema.Types.ObjectId, ref: "GroupAssignment", required: true },
  groupId:           { type: Schema.Types.ObjectId, required: true }, // Refers to groups._id in GroupAssignment

  submittedBy:       { type: Schema.Types.ObjectId, ref: "User", required: true },
  files:             [{
    url: String,
    originalname: String,
    filetype: String,
    extractedText: String,
  }],
  combinedText:         { type: String, default: '' },
  embedding:            [{ type: Number }],
  isFlagged:            { type: Boolean, default: false },
  plagiarismPercentage: { type: Number, default: 0 },
  plagiarismMatches:    [plagiarismMatchSchema],

  submittedAt: { type: Date, default: Date.now },

  feedback: { type: String },
  grade:    { type: Number }
});

export default mongoose.models.GroupAssignmentSubmission ||
  mongoose.model("GroupAssignmentSubmission", groupAssignmentSubmissionSchema);
