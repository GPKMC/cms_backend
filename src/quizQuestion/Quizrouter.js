// routes/quizRouter.js
import express from "express";
import { body, param, validationResult } from "express-validator";
import QuizQuestion from "./quizquestion-model.js";
import Submission from "./submission-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

const QuizRouter = express.Router();

// validation helper
function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
}

// ─── 1. Create a quiz ─────────────────────────
QuizRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  [
    body("title").isString().notEmpty(),
    body("description").optional().isString(),
    body("courseInstance").isMongoId(),
    body("dueDate").optional().isISO8601()
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.create({
        title:          req.body.title,
        description:    req.body.description,
        courseInstance: req.body.courseInstance,
        createdBy:      req.user._id,
        dueDate:        req.body.dueDate
      });
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
    body("dueDate").optional().isISO8601()
  ],
  validate,
  async (req, res, next) => {
    try {
      const updates = (({ title, description, dueDate }) => ({ title, description, dueDate }))(req.body);
      const quiz = await QuizQuestion.findByIdAndUpdate(req.params.quizId, updates, { new: true });
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

// ─── 5. Add a question (Step 1: no correctOption) ────
QuizRouter.post(
  "/:quizId/questions",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    body("text").isString().notEmpty(),
    body("type").isIn(["mcq", "short_answer"]),
    body("points").isInt({ min: 0 }),
    body("options")
      .if(body("type").equals("mcq"))
      .isArray({ min: 1 })
      .withMessage("MCQ must have at least one option"),
    body("options.*.text")
      .if(body("type").equals("mcq"))
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
        type:              req.body.type,
        points:            req.body.points,
        options:           req.body.options,
        feedbackCorrect:   req.body.feedbackCorrect,
        feedbackIncorrect: req.body.feedbackIncorrect
      });

      await quiz.save();
      // return entire quiz so client can read the generated option IDs
      res.status(201).json(quiz);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 6. Patch correctOption (Step 2) ─────────────
QuizRouter.patch(
  "/:quizId/questions/:questionId",
  authmiddleware,
  authorizedRole("teacher"),
  [
    param("quizId").isMongoId(),
    param("questionId").isMongoId(),
    body("correctOption").isMongoId(),       // now a real ObjectId
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

// ─── 7. Submission endpoints ─────────────────────
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

QuizRouter.post(
  "/:quizId/submit",
  authmiddleware,
  authorizedRole("student"),
  [
    param("quizId").isMongoId(),
    body("answers").isArray({ min: 1 }),
    body("answers.*.question").isMongoId(),
    body("answers.*.selectedOption").optional().isMongoId(),
    body("answers.*.textAnswer").optional().isString()
  ],
  validate,
  async (req, res, next) => {
    try {
      const quiz = await QuizQuestion.findById(req.params.quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      let total = 0;
      const graded = quiz.questions.map(q => {
        const ans = req.body.answers.find(a => a.question === String(q._id))||{};
        let earned = 0;
        if (q.type==="mcq" && String(q.correctOption)===ans.selectedOption) earned=q.points;
        total += earned;
        return {
          question:      q._id,
          selectedOption: ans.selectedOption,
          textAnswer:    ans.textAnswer,
          earnedPoints:  earned,
          feedback:      earned===q.points?q.feedbackCorrect:q.feedbackIncorrect
        };
      });

      const sub = await Submission.findOneAndUpdate(
        { quiz: quiz._id, student: req.user._id },
        {
          answers: graded,
          totalScore: total,
          status: "submitted",
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
