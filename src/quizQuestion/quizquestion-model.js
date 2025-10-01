import mongoose from "mongoose";
const { Schema, model } = mongoose;

/* ---------- Sub-schemas ---------- */
const OptionSchema = new Schema(
  {
    text: { type: String, required: true },
  },
  { _id: true }
);

const QuestionSchema = new Schema(
  {
    text: { type: String, required: true },
    type: { type: String, enum: ["mcq"], default: "mcq" },
    points: { type: Number, default: 0 },
    options: { type: [OptionSchema], default: [] },

    // IMPORTANT: this points to one of the option subdocument _ids
    correctOption: { type: Schema.Types.ObjectId },

    feedbackCorrect: { type: String, default: "" },
    feedbackIncorrect: { type: String, default: "" },
  },
  { _id: true, timestamps: false }
);

/* ---------- Top-level quiz schema ---------- */
const QuizQuestionSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },

    courseInstance: {
      type: Schema.Types.ObjectId,
      ref: "CourseInstance",
      required: true,
      index: true,
    },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    topic: { type: Schema.Types.ObjectId, ref: "Topic" },

    dueDate: { type: Date },

    // Draft/publish control
    published: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date },

    questions: { type: [QuestionSchema], default: [] },
  },
  { timestamps: true }
);

export default model("QuizQuestion", QuizQuestionSchema);
