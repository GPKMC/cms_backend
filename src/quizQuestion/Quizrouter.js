// quizQuestion/quizRouter.js
import express from "express";
import { body, param, validationResult } from "express-validator";
import QuizQuestion from "./quizquestion-model.js";
import Submission from "./submission-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import notificationModel from "../functions/notification-model.js";


const QuizRouter = express.Router();

/* ───────────────── helpers ───────────────── */
function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  next();
}
const isFutureDate = (value) => {
  const ts = new Date(value).getTime();
  if (isNaN(ts)) throw new Error("Invalid date format");
  if (ts <= Date.now()) throw new Error("dueDate must be in the future");
  return true;
};

/* ─── 1) Create a quiz (DRAFT by default) ───────────────────── */
QuizRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  [
    body("title").isString().notEmpty(),
    body("description").optional().isString(),
    body("courseInstance").isMongoId(),
    body("dueDate").optional().isISO8601().bail().custom(isFutureDate),
    body("published").optional().isBoolean(), // allow explicit create-as-published if you want
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.create({
        title: req.body.title,
        description: req.body.description || "",
        courseInstance: req.body.courseInstance,
        postedBy: req.user._id,
        dueDate: req.body.dueDate,
        published: !!req.body.published, // still safe; you can force false if you want drafts only
        publishedAt: req.body.published ? new Date() : undefined,
      });

      // NOTE: No notifications here. We notify on publish (see publish route).
      return res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

/* ─── 2) List quizzes for a course ─────────────────────────────
   Students see only published quizzes; teachers/admins see all. */
QuizRouter.get(
  "/course/:courseInstanceId",
  authmiddleware,
  authorizedRole("student", "teacher", "admin", "superadmin"),
  param("courseInstanceId").isMongoId(),
  validate,
  async (req, res, next) => {
    try {
      const baseFilter = { courseInstance: req.params.courseInstanceId };
      const filter =
        req.user.role === "student" ? { ...baseFilter, published: true } : baseFilter;

      const qs = await QuizQuestion.find(filter)
        .select(
          "title description dueDate published publishedAt questions postedBy topic createdAt updatedAt"
        )
        .populate("postedBy", "username role _id")
        .populate("topic", "title _id")
        .lean();

      const items = qs.map((q) => ({
        _id: q._id,
        type: "quiz",
        title: q.title,
        previewHtml: q.description || "",
        description: q.description || "",
        questionCount: (q.questions || []).length,
        published: !!q.published,
        publishedAt: q.publishedAt || null,
        dueAt: q.dueDate || null,
        postedBy: q.postedBy,
        topic: q.topic,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      }));

      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

/* ─── 3) Fetch a quiz by ID ────────────────────────────────────
   Students may not open drafts. */
QuizRouter.get(
  "/:quizId",
  authmiddleware,
  param("quizId").isMongoId(),
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      if (req.user.role === "student" && !quiz.published) {
        return res.status(403).json({ message: "Quiz is not published" });
      }
      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

/* ─── 4) Update quiz metadata (title/description/dueDate) ───── */
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

/* ─── 5) Publish / Unpublish ───────────────────────────────────
   Sends notifications when transitioning from draft -> published. */
QuizRouter.patch(
  "/:quizId/publish",
  authmiddleware,
  authorizedRole("teacher"),
  [param("quizId").isMongoId(), body("published").isBoolean()],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const wasPublished = !!quiz.published;
      quiz.published = !!req.body.published;
      quiz.publishedAt = quiz.published ? new Date() : undefined;
      await quiz.save();

      // Notify only on the transition to published
      if (!wasPublished && quiz.published) {
        try {
          const courseInstance = await CourseInstance.findById(quiz.courseInstance);
          if (courseInstance) {
            const students = await User.find({
              role: "student",
              batch: courseInstance.batch,
            }).select("_id");
            const recipients = students.map((s) => String(s._id));
            if (recipients.length) {
              await notificationModel.create({
                courseInstance: quiz.courseInstance,
                type: "quiz",
                refId: quiz._id,
                title: quiz.title,
                message: `New quiz published: ${quiz.title}`,
                createdBy: req.user._id,
                recipients,
              });
            }
          }
        } catch {
          /* non-fatal notify */
        }
      }

      res.json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

/* ─── 6) Add MCQ question ───────────────────────────────────── */
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
        options: req.body.options, // [{text}]
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

/* ─── 7) Update a question (strict after publish/submissions) ─ */
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
    body("correctOption").optional().isMongoId(), // must be an existing option _id
    body("options").optional().isArray({ min: 2 }),
    body("options.*.text").optional().isString().notEmpty(),
    body("options.*._id").optional().isMongoId(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { quizId, questionId } = req.params;
      const {
        text,
        points,
        feedbackCorrect,
        feedbackIncorrect,
        options,
        correctOption,
      } = req.body;

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
          // Strict mode: update text only; no add/remove/reorder
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
          const byIdText = new Map(options.map((o) => [String(o._id), o.text]));
          q.options.forEach((opt) => {
            const newText = byIdText.get(String(opt._id));
            if (typeof newText === "string") opt.text = newText;
          });
        } else {
          // Flexible mode: you may replace the whole array
          const currentMap = new Map(q.options.map((o) => [String(o._id), o]));
          q.options = options.map((o) => {
            if (o._id && currentMap.has(String(o._id))) {
              return { _id: currentMap.get(String(o._id))._id, text: o.text };
            }
            return { text: o.text };
          });

          // If the previous correctOption is no longer present, clear it
          if (
            q.correctOption &&
            !q.options.some((o) => String(o._id) === String(q.correctOption))
          ) {
            q.correctOption = undefined;
          }
        }
      }

      if (typeof correctOption === "string") {
        const exists = q.options.some(
          (o) => String(o._id) === String(correctOption)
        );
        if (!exists) {
          return res
            .status(400)
            .json({ message: "correctOption must be one of the current option IDs." });
        }
        q.correctOption = correctOption; // stored as ObjectId
      }

      await quiz.save();
      const updated = quiz.questions.id(questionId);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/* ─── 8) Delete a quiz ──────────────────────────────────────── */
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

/* ─── 9) Delete a question ───────────────────────────────────── */
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
