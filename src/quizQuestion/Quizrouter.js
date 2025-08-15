// routes/quizRouter.js
import express from "express";
import { body, param, validationResult } from "express-validator";
import QuizQuestion from "./quizquestion-model.js";
import Submission from "./submission-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import notificationModel from "../functions/notification-model.js";

const QuizRouter = express.Router();

// ───────────────── helpers ─────────────────
function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
}

const isFutureDate = (value) => {
  const ts = new Date(value).getTime();
  if (isNaN(ts)) throw new Error("Invalid date format");
  if (ts <= Date.now()) throw new Error("dueDate must be in the future");
  return true;
};

// ─── 1) Create a quiz ─────────────────────
QuizRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  [
    body("title").isString().notEmpty(),
    body("description").optional().isString(),
    body("courseInstance").isMongoId(),
    body("dueDate").optional().isISO8601().bail().custom(isFutureDate),
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.create({
        title: req.body.title,
        description: req.body.description,
        courseInstance: req.body.courseInstance,
        postedBy: req.user._id,
        dueDate: req.body.dueDate,
      });

      // Notify students in the course's batch (optional)
      try {
        let recipients = [];
        const courseInstance = await CourseInstance.findById(quiz.courseInstance);
        if (courseInstance) {
          const batchStudents = await User.find({
            role: "student",
            batch: courseInstance.batch,
          }).select("_id");
          recipients = batchStudents.map((s) => String(s._id));
        }
        if (recipients.length) {
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
      } catch { /* non-fatal */ }

      res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 2) Fetch a quiz ──────────────────────
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

// ─── 3) Update quiz metadata (title/description/dueDate) ───────────
QuizRouter.patch(
  "/:quizId",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("title").optional().isString().notEmpty(),
    body("description").optional().isString(),
    body("dueDate").optional().isISO8601().bail().custom(isFutureDate),
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const { title, description, dueDate } = req.body;
      if (typeof title === "string") quiz.title = title;
      if (typeof description === "string") quiz.description = description;
      if (typeof dueDate === "string") quiz.dueDate = new Date(dueDate);

      await quiz.save();
      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4) Publish / Unpublish ───────────────
QuizRouter.patch(
  "/:quizId/publish",
  authmiddleware,
  authorizedRole("teacher"),
  [param("quizId").isMongoId(), body("published").isBoolean()],
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

// ─── 5) Add an MCQ to a quiz ──────────────
QuizRouter.post(
  "/:quizId/questions",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("text").isString().notEmpty(),
    body("type").equals("mcq").withMessage('type must be "mcq"'),
    body("points").isInt({ min: 0 }),
    body("options").isArray({ min: 2 }),
    body("options.*.text").isString().notEmpty(),
    body("feedbackCorrect").optional().isString(),
    body("feedbackIncorrect").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      quiz.questions.push({
        text: req.body.text,
        type: "mcq",
        points: req.body.points,
        options: req.body.options,
        feedbackCorrect: req.body.feedbackCorrect,
        feedbackIncorrect: req.body.feedbackIncorrect,
      });

      await quiz.save();
      res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 6) Update a question (text/points/feedback/options/correct) ───
//     NOTE: This single route handles *both* full edits and "correct option only" edits.
QuizRouter.patch(
  "/:quizId/questions/:questionId",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    param("questionId").isMongoId(),
    body("text").optional().isString().notEmpty(),
    body("points").optional().isInt({ min: 0 }),
    body("feedbackCorrect").optional().isString(),
    body("feedbackIncorrect").optional().isString(),
    body("correctOption").optional().isMongoId(),
    body("options").optional().isArray({ min: 2 }),
    body("options.*.text").optional().isString().notEmpty(),
    body("options.*._id").optional().isMongoId(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { quizId, questionId } = req.params;
      const { text, points, feedbackCorrect, feedbackIncorrect, options, correctOption } = req.body;

      const quiz = await QuizQuestion.findById(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const q = quiz.questions.id(questionId);
      if (!q) return res.status(404).json({ message: "Question not found" });

      if (typeof text === "string") q.text = text;
      if (typeof points === "number") q.points = points;
      if (typeof feedbackCorrect === "string") q.feedbackCorrect = feedbackCorrect;
      if (typeof feedbackIncorrect === "string") q.feedbackIncorrect = feedbackIncorrect;

      const hasSubs = await Submission.exists({ quiz: quiz._id });
      const isPublished = !!quiz.published;

      if (Array.isArray(options)) {
        if (isPublished || hasSubs) {
          // strict: update text only, no add/remove
          if (options.length !== q.options.length) {
            return res.status(400).json({
              message:
                "Cannot add/remove options after publish or once submissions exist.",
            });
          }
          const existingIds = new Set(q.options.map((o) => String(o._id)));
          for (const incoming of options) {
            if (!incoming._id || !existingIds.has(String(incoming._id))) {
              return res.status(400).json({
                message:
                  "All provided options must include existing _id in strict mode.",
              });
            }
          }
          const byId = new Map(options.map((o) => [String(o._id), o.text]));
          q.options.forEach((opt) => {
            const newText = byId.get(String(opt._id));
            if (typeof newText === "string") opt.text = newText;
          });
        } else {
          // flexible: replace array, preserving _id where provided
          const existingMap = new Map(q.options.map((o) => [String(o._id), o]));
          q.options = options.map((o) => {
            if (o._id && existingMap.has(String(o._id))) {
              return { _id: existingMap.get(String(o._id))._id, text: o.text };
            }
            return { text: o.text };
          });

          // if old correctOption no longer exists, clear it
          if (
            q.correctOption &&
            !q.options.some((o) => String(o._id) === String(q.correctOption))
          ) {
            q.correctOption = undefined;
          }
        }
      }

      if (typeof correctOption === "string") {
        const exists = q.options.some((o) => String(o._id) === String(correctOption));
        if (!exists) {
          return res
            .status(400)
            .json({ message: "correctOption must be one of the current option IDs." });
        }
        q.correctOption = correctOption;
      }

      await quiz.save();
      const updated = quiz.questions.id(questionId);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 7) Get-or-create submission (student) ─────
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
        quiz: quiz._id,
        student: req.user._id,
      });
      if (!sub) {
        sub = await Submission.create({
          quiz: quiz._id,
          student: req.user._id,
          answers: [],
        });
      }
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 8) Submit answers + auto-score (student) ──
QuizRouter.post(
  "/:quizId/submit",
  authmiddleware,
  authorizedRole("student"),
  [
    param("quizId").isMongoId(),
    body("answers").isArray({ min: 1 }),
    body("answers.*.question").isMongoId(),
    body("answers.*.selectedOption").isMongoId(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      let total = 0;
      const graded = quiz.questions.map((q) => {
        const ans = req.body.answers.find((a) => a.question === String(q._id)) || {};
        const earned = String(q.correctOption) === ans.selectedOption ? q.points : 0;
        total += earned;
        return {
          question: q._id,
          selectedOption: ans.selectedOption,
          earnedPoints: earned,
          feedback: earned === q.points ? q.feedbackCorrect : q.feedbackIncorrect,
        };
      });

      const sub = await Submission.findOneAndUpdate(
        { quiz: quiz._id, student: req.user._id },
        {
          answers: graded,
          totalScore: total,
          status: "submitted",
          submittedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 9) Delete a quiz (and its submissions) ────
QuizRouter.delete(
  "/:quizId",
  authmiddleware,
  authorizedRole("teacher"),
  param("quizId").isMongoId(),
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      await Submission.deleteMany({ quiz: quiz._id });
      await quiz.deleteOne();

      res.json({ ok: true, message: "Quiz deleted" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 10) Delete a single question ──────────────
QuizRouter.delete(
  "/:quizId/questions/:questionId",
  authmiddleware,
  authorizedRole("teacher"),
  [param("quizId").isMongoId(), param("questionId").isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const q = quiz.questions.id(req.params.questionId);
      if (!q) return res.status(404).json({ message: "Question not found" });

      q.deleteOne();
      await quiz.save();

      res.json({ ok: true, message: "Question removed", quiz });
    } catch (err) {
      next(err);
    }
  }
);

export default QuizRouter;
