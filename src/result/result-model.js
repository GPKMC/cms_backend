// models/internalRecord.model.ts
import mongoose from "mongoose";

const internalRecordSchema = new mongoose.Schema(
  {
    courseInstance: { type: mongoose.Schema.Types.ObjectId, ref: "CourseInstance", required: true },
    student:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind:           { type: String, enum: ["exam", "practical"], required: true },

    // exam-only
    attemptNo: { type: Number, min: 1, max: 3 },
    examTitle: { type: String },
    examDate:  { type: Date },
    maxMarks:  { type: Number, min: 0 },
    marks:     { type: Number, min: 0 },

    // practical-only (breakdown + total)
    pFirst:   { type: Number, min: 0, max: 5 }, // (5)
    pFinal:   { type: Number, min: 0, max: 5 }, // (5)
    pAssign:  { type: Number, min: 0, max: 5 }, // (5)
    pAttend:  { type: Number, min: 0, max: 5 }, // (5)
    practicalTotal: { type: Number, min: 0 },   // auto = sum of parts

    remarks:   { type: String },

    filledBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lockedByAdmin: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* Validation & coercion */
internalRecordSchema.pre("validate", function (next) {
  const doc = this;

  if (doc.kind === "exam") {
    if (![1, 2, 3].includes(doc.attemptNo)) {
      return next(new Error("attemptNo (1|2|3) is required for exam"));
    }
    if (typeof doc.maxMarks !== "number" || typeof doc.marks !== "number") {
      return next(new Error("maxMarks and marks are required for exam"));
    }
    if (doc.marks > doc.maxMarks) {
      return next(new Error("marks cannot exceed maxMarks"));
    }
    if (doc.practicalTotal != null || doc.pFirst != null || doc.pFinal != null || doc.pAssign != null || doc.pAttend != null) {
      return next(new Error("practical fields must be empty for exam kind"));
    }
  }

  if (doc.kind === "practical") {
    // If any parts present, compute total from parts.
    const hasAnyPart =
      doc.pFirst != null || doc.pFinal != null || doc.pAssign != null || doc.pAttend != null;

    if (hasAnyPart) {
      const total =
        (Number(doc.pFirst) || 0) +
        (Number(doc.pFinal) || 0) +
        (Number(doc.pAssign) || 0) +
        (Number(doc.pAttend) || 0);
      doc.practicalTotal = total; // overwrite to ensure consistency
    }

    // Must have either parts or a total
    if (!hasAnyPart && doc.practicalTotal == null) {
      return next(new Error("Provide practicalTotal or parts (pFirst, pFinal, pAssign, pAttend)"));
    }

    // Exam-only fields must be empty
    if (doc.attemptNo != null || doc.maxMarks != null || doc.marks != null) {
      return next(new Error("attemptNo/maxMarks/marks must be empty for practical kind"));
    }
  }

  next();
});

/* Uniqueness */
internalRecordSchema.index(
  { courseInstance: 1, student: 1, kind: 1, attemptNo: 1 },
  { unique: true, partialFilterExpression: { kind: "exam" } }
);

internalRecordSchema.index(
  { courseInstance: 1, student: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "practical" } }
);

export default mongoose.model("InternalRecord", internalRecordSchema);
