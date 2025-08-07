// routes/quizRouter.js
import express from "express";
import { body, param, validationResult } from "express-validator";
import QuizQuestion from "./quizquestion-model.js";
import Submission   from "./submission-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import notificationModel from "../functions/notification-model.js";

const QuizRouter = express.Router();

// validation helper
function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
}

// ensure a date is in the future
const isFutureDate = (value) => {
  const ts = new Date(value).getTime();
  if (isNaN(ts)) throw new Error("Invalid date format");
  if (ts <= Date.now()) throw new Error("dueDate must be in the future");
  return true;
};

// ─── 1. Create a quiz ─────────────────────────
// QuizRouter.post(
//   "/",
//   authmiddleware,
//   authorizedRole("teacher"),
//   [
//     body("title").isString().notEmpty(),
//     body("description").optional().isString(),
//     body("courseInstance").isMongoId(),
//     body("dueDate")
//       .optional()
//       .isISO8601().withMessage("dueDate must be a valid ISO8601 date")
//       .bail()
//       .custom(isFutureDate)
//   ],
//   validate,
//   async (req, res, next) => {
//     try {
//       const quiz = await QuizQuestion.create({
//         title:          req.body.title,
//         description:    req.body.description,
//         courseInstance: req.body.courseInstance,
//         postedBy:       req.user._id,
//         dueDate:        req.body.dueDate
//       });
//       res.status(201).json(quiz);
//     } catch (err) {
//       next(err);
//     }
//   }
// );


// ...the rest of your QuizRouter code above...

QuizRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  [
    body("title").isString().notEmpty(),
    body("description").optional().isString(),
    body("courseInstance").isMongoId(),
    body("dueDate")
      .optional()
      .isISO8601().withMessage("dueDate must be a valid ISO8601 date")
      .bail()
      .custom(isFutureDate)
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.create({
        title:          req.body.title,
        description:    req.body.description,
        courseInstance: req.body.courseInstance,
        postedBy:       req.user._id,
        dueDate:        req.body.dueDate
      });

      // ---- Notification logic here ----
      let recipients = [];
      // You can add a "visibleTo" field like in other models for more granular access, or notify the whole batch.
      const courseInstance = await CourseInstance.findById(quiz.courseInstance);
      if (courseInstance) {
        const batchStudents = await User.find({
          role: "student",
          batch: courseInstance.batch,
        }).select("_id");
        recipients = batchStudents.map(s => s._id.toString());
      }
      if (recipients.length > 0) {
        await notificationModel.create({
          courseInstance: quiz.courseInstance,
          type: "quiz",
          refId: quiz._id,
          title: quiz.title,
          message: `New quiz posted: ${quiz.title}`,
          createdBy: req.user._id,
          recipients,
        });
      }
      // ---- End notification logic ----

      res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 2. Fetch a quiz ───────────────────────────
QuizRouter.get(
  "/:quizId",
  authmiddleware,
  param("quizId").isMongoId(),
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 3. Update metadata ────────────────────────
QuizRouter.patch(
  "/:quizId",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("title").optional().isString().notEmpty(),
    body("description").optional().isString(),
    body("dueDate")
      .optional()
      .isISO8601().withMessage("dueDate must be a valid ISO8601 date")
      .bail()
      .custom(isFutureDate)
  ],
  validate,
  async (req, res, next) => {
    try {
      const updates = (({ title, description, dueDate }) => ({
        title, description, dueDate
      }))(req.body);

      const quiz = await QuizQuestion.findByIdAndUpdate(
        req.params.quizId,
        updates,
        { new: true }
      );
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4. Publish / Unpublish ────────────────────
QuizRouter.patch(
  "/:quizId/publish",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("published").isBoolean()
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findByIdAndUpdate(
        req.params.quizId,
        { published: req.body.published },
        { new: true }
      );
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 5. Add an MCQ ─────────────────────────────
QuizRouter.post(
  "/:quizId/questions",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("text").isString().notEmpty(),
    // only mcq type
    body("type").equals("mcq").withMessage('type must be "mcq"'),
    body("points").isInt({ min: 0 }),
    body("options")
      .isArray({ min: 2 })
      .withMessage("MCQ must have at least two options"),
    body("options.*.text")
      .isString().notEmpty(),
    body("feedbackCorrect").optional().isString(),
    body("feedbackIncorrect").optional().isString()
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      quiz.questions.push({
        text:              req.body.text,
        type:              "mcq",
        points:            req.body.points,
        options:           req.body.options,
        feedbackCorrect:   req.body.feedbackCorrect,
        feedbackIncorrect: req.body.feedbackIncorrect
      });
      await quiz.save();
      res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 6. Set correctOption ──────────────────────
QuizRouter.patch(
  "/:quizId/questions/:questionId",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    param("questionId").isMongoId(),
    body("correctOption").isMongoId()
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const q = quiz.questions.id(req.params.questionId);
      if (!q) return res.status(404).json({ message: "Question not found" });

      q.correctOption = req.body.correctOption;
      await quiz.save();
      res.json(q);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 7. Get-or-create submission ───────────────
QuizRouter.get(
  "/:quizId/submission",
  authmiddleware,
  authorizedRole("student"),
  param("quizId").isMongoId(),
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      let sub = await Submission.findOne({
        quiz:    quiz._id,
        student: req.user._id
      });
      if (!sub) {
        sub = await Submission.create({
          quiz:    quiz._id,
          student: req.user._id,
          answers: []
        });
      }
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 8. Submit + auto-score MCQ answers ─────────
QuizRouter.post(
  "/:quizId/submit",
  authmiddleware,
  authorizedRole("student"),
  [
    param("quizId").isMongoId(),
    body("answers").isArray({ min: 1 }),
    body("answers.*.question").isMongoId(),
    body("answers.*.selectedOption")
      .isMongoId()
      .withMessage("selectedOption must be a valid option ID")
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      // grade each MCQ
      let total = 0;
      const graded = quiz.questions.map(q => {
        const ans = req.body.answers.find(a => a.question === String(q._id)) || {};
        const earned = String(q.correctOption) === ans.selectedOption ? q.points : 0;
        total += earned;
        return {
          question:       q._id,
          selectedOption: ans.selectedOption,
          earnedPoints:   earned,
          feedback:       earned === q.points ? q.feedbackCorrect : q.feedbackIncorrect
        };
      });

      // upsert submission record
      const sub = await Submission.findOneAndUpdate(
        { quiz: quiz._id, student: req.user._id },
        {
          answers:     graded,
          totalScore:  total,
          status:      "submitted",
          submittedAt: new Date()
        },
        { upsert: true, new: true }
      );
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

export default QuizRouter;
