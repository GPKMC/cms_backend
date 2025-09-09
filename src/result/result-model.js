// models/result-model.js
import mongoose from "mongoose";

const internalRecordSchema = new mongoose.Schema(
  {
    courseInstance: { type: mongoose.Schema.Types.ObjectId, ref: "CourseInstance", required: true },
    student:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind:           { type: String, enum: ["exam", "practical"], required: true },

    /* exam-only */
    examSlot:   { type: Number, min: 1 }, // required when kind="exam"
    attemptNo:  { type: Number, min: 1 }, // required when kind="exam"
    examTitle:  { type: String },
    examDate:   { type: Date },
    maxMarks:   { type: Number, min: 0 },
    marks:      { type: Number, min: 0 },

    // NEW: how to interpret exam marks
    // - "scored": marks/maxMarks must be present
    // - "ab": absent (marks may be empty)
    // - "not_assigned": didn’t get an exam seat / not assigned
    examOutcome: { type: String, enum: ["scored", "ab", "not_assigned"], default: "scored" },

    /* common */
    passMarks: { type: Number, min: 0 },

    /* practical-only */
    pFirst:   { type: Number, min: 0 },
    pFinal:   { type: Number, min: 0 },
    pAssign:  { type: Number, min: 0 },
    pAttend:  { type: Number, min: 0 },
    practicalTotal: { type: Number, min: 0 },

    remarks:   { type: String },

    /* audit */
    filledBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    verifiedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lockedByAdmin: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* helpers */
function defaultExamPass(maxMarks) {
  if (typeof maxMarks !== "number" || !Number.isFinite(maxMarks)) return undefined;
  return Math.ceil(0.4 * maxMarks);
}

/* validation & normalization */
internalRecordSchema.pre("validate", function(next) {
  const doc = this;

  if (doc.kind === "exam") {
    if (!Number.isInteger(doc.examSlot) || doc.examSlot < 1) {
      return next(new Error("examSlot (>=1) is required for exam"));
    }
    if (!Number.isInteger(doc.attemptNo) || doc.attemptNo < 1) {
      return next(new Error("attemptNo (>=1) is required for exam"));
    }

    if (doc.examOutcome === "scored") {
      if (typeof doc.maxMarks !== "number" || typeof doc.marks !== "number") {
        return next(new Error("maxMarks and marks are required when examOutcome='scored'"));
      }
      if (doc.marks > doc.maxMarks) {
        return next(new Error("marks cannot exceed maxMarks"));
      }
      if (doc.passMarks == null && doc.maxMarks != null) {
        doc.passMarks = defaultExamPass(doc.maxMarks);
      }
    } else {
      // AB or NOT ASSIGNED -> allow marks/maxMarks to be empty
      // (If provided, keep normal constraints)
      if (doc.marks != null && doc.maxMarks != null && doc.marks > doc.maxMarks) {
        return next(new Error("marks cannot exceed maxMarks"));
      }
    }

    // practical fields must be empty for exam
    if (doc.practicalTotal != null || doc.pFirst != null || doc.pFinal != null || doc.pAssign != null || doc.pAttend != null) {
      return next(new Error("practical fields must be empty for exam kind"));
    }
  }

  if (doc.kind === "practical") {
    const hasAnyPart = doc.pFirst != null || doc.pFinal != null || doc.pAssign != null || doc.pAttend != null;
    if (hasAnyPart) {
      doc.practicalTotal =
        (Number(doc.pFirst)  || 0) +
        (Number(doc.pFinal)  || 0) +
        (Number(doc.pAssign) || 0) +
        (Number(doc.pAttend) || 0);
    }
    if (!hasAnyPart && doc.practicalTotal == null) {
      return next(new Error("Provide practicalTotal or parts (pFirst, pFinal, pAssign, pAttend)"));
    }
    if (doc.examSlot != null || doc.attemptNo != null || doc.maxMarks != null || doc.marks != null) {
      return next(new Error("examSlot/attemptNo/maxMarks/marks must be empty for practical kind"));
    }
  }

  if (doc.kind === "exam" && doc.examOutcome === "scored" && doc.passMarks != null && doc.maxMarks != null && doc.passMarks > doc.maxMarks) {
    return next(new Error("passMarks cannot exceed maxMarks"));
  }

  next();
});

/* computed status:
   - exam: "AB" if examOutcome='ab'; "NA" if 'not_assigned';
            else Pass/Fail by marks >= passMarks
   - practical: Pass/Fail by practicalTotal >= passMarks
*/
internalRecordSchema.virtual("status").get(function () {
  if (this.kind === "exam") {
    if (this.examOutcome === "ab") return "AB";
    if (this.examOutcome === "not_assigned") return "NA";
    const m = Number(this.marks), p = Number(this.passMarks);
    if (Number.isFinite(m) && Number.isFinite(p)) return m >= p ? "Pass" : "Fail";
    return "NA";
  }
  if (this.kind === "practical") {
    const t = Number(this.practicalTotal), p = Number(this.passMarks);
    if (Number.isFinite(t) && Number.isFinite(p)) return t >= p ? "Pass" : "Fail";
    return "NA";
  }
  return "NA";
});

/* uniqueness */
internalRecordSchema.index(
  { courseInstance: 1, student: 1, kind: 1, examSlot: 1, attemptNo: 1 },
  { unique: true, partialFilterExpression: { kind: "exam" } }
);

internalRecordSchema.index(
  { courseInstance: 1, student: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "practical" } }
);

export default mongoose.model("InternalRecord", internalRecordSchema);
