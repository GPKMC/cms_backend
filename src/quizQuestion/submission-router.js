// routes/quizSubmissionRouter.js
import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import QuizSubmission from './submission-model.js';
import QuizQuestion from './quizquestion-model.js';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';

const QuizSubmissionrouter = express.Router();

/** Validate incoming request fields */
function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
}

/**
 * Load submission by ID and ensure that:
 * - students only access their own
 * - teachers can access any
 */
async function ensureOwnerOrTeacher(req, res, next) {
  try {
    const sub = await QuizSubmission.findById(req.params.id);
    if (!sub) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    if (req.user.role === 'student' && sub.student.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    req.submission = sub;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * POST /quiz-submissions
 * Start (or fetch) one submission per (quiz, student)
 * Access: student
 */

QuizSubmissionrouter.post(
  '/',
  authmiddleware,
  authorizedRole('student'),
  body('quiz').isMongoId().withMessage('quiz id is required'),
  validate,
  async (req, res, next) => {
    const student = req.user.id;
    const { quiz } = req.body;

    try {
      // 1) Already started?
      let submission = await QuizSubmission.findOne({ quiz, student });
      if (submission) {
        return res.status(200).json({ message: 'Already started', submission });
      }

      // 2) Create new
      submission = await QuizSubmission.create({ quiz, student });
      return res.status(201).json(submission);

    } catch (err) {
      // 3) Race will hit unique‐index error → fetch & return existing
      if (err.code === 11000) {
        const dup = await QuizSubmission.findOne({ quiz, student });
        return res.status(200).json({ submission: dup });
      }
      next(err);
    }
  }
);

/**
 * GET /quiz-submissions
 * List submissions:
 *  - students get only their own
 *  - teachers may pass ?studentId=XYZ to fetch that student's
 * Access: student, teacher
 */
// routes/quizSubmissionRouter.js
QuizSubmissionrouter.get(
 '/:id',
  authmiddleware,
  authorizedRole('student','teacher'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  validate,
  async (req, res, next) => {
    try {
      // 1) Load the submission (answers.question is just an ObjectId here)
      const sub = await QuizSubmission.findById(req.params.id).lean();
      if (!sub) return res.status(404).json({ message: 'Not found' });

      // 2) Authorization: students only their own
      if (req.user.role === 'student' && sub.student.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      // 3) Load the quiz document (with questions[])
      const quiz = await QuizQuestion.findById(sub.quiz).lean();
      if (!quiz) return res.status(500).json({ message: 'Quiz not found' });

      // 4) Merge each answer with its matching question sub-doc
      const answers = sub.answers.map(ans => {
        const question = quiz.questions.find(q =>
          q._id.toString() === ans.question?.toString()
        ) || null;
        return { 
          ...ans,
          question 
        };
      });

      // 5) Return a single object with populated quiz and answers.question
      return res.json({
        ...sub,
        quiz,
        answers
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * GET /quiz-submissions/:id
 * Fetch one submission (with answers, score, any feedback)
 * Access: student (own only), teacher (any)
 */
QuizSubmissionrouter.get(
  '/:id',
  authmiddleware,
  authorizedRole('student', 'teacher'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  validate,
  ensureOwnerOrTeacher,
  async (req, res, next) => {
    try {
      const sub = req.submission;
      // Populate fields if needed
      if (!sub.populated('quiz')) {
        await sub.populate({ path: 'quiz', model: 'QuizQuestion' });
      }
      if (!sub.populated('answers.question')) {
        await sub.populate({ path: 'answers.question', model: 'QuizQuestion' });
      }
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /quiz-submissions/:id/answers
 * Update answers for an in-progress submission
 * Access: student (own only)
 */
QuizSubmissionrouter.patch(
  '/:id/answers',
  authmiddleware,
  authorizedRole('student'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  body('answers').isArray({ min: 1 }).withMessage('Answers must be a non-empty array'),
  validate,
  ensureOwnerOrTeacher,
  async (req, res, next) => {
    try {
      const sub = req.submission;
      if (sub.status === 'submitted') {
        return res.status(400).json({ message: 'Quiz already submitted' });
      }
      sub.answers = req.body.answers;
      await sub.save();
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /quiz-submissions/:id/submit
 * Finalize submission: auto-score and mark submitted
 * Access: student (own only)
 */
QuizSubmissionrouter.post(
  '/:id/submit',
  authmiddleware,
  authorizedRole('student'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  validate,
  ensureOwnerOrTeacher,
  async (req, res, next) => {
    try {
      const sub = req.submission;
      if (sub.status === 'submitted') {
        return res.status(400).json({ message: 'Quiz already submitted' });
      }

      // Load quiz to score answers
      const quizDoc = await QuizQuestion.findById(sub.quiz);
      if (!quizDoc) {
        return res.status(500).json({ message: 'Quiz not found for scoring' });
      }

      let total = 0;
      sub.answers = sub.answers.map(ans => {
        const q = quizDoc.questions.find(
          (qq) => qq._id.toString() === ans.question.toString()
        );
        const earned = q && ans.selectedOption === q.correctOption ? q.points : 0;
        ans.earnedPoints = earned;
        total += earned;
        return ans;
      });

      sub.totalScore = total;
      sub.status = 'submitted';
      sub.submittedAt = new Date();
      await sub.save();

      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /quiz-submissions/:id/feedback
 * (Teacher only) Add earnedPoints and teacherFeedback per answer
 * Access: teacher
 */
QuizSubmissionrouter.patch(
  '/:id/feedback',
  authmiddleware,
  authorizedRole('teacher'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  body('answers').isArray({ min: 1 }).withMessage('Answers must be a non-empty array'),
  validate,
  ensureOwnerOrTeacher,
  async (req, res, next) => {
    try {
      const sub = req.submission;
      for (const upd of req.body.answers) {
        const ans = sub.answers.find(
          (a) => a.question.toString() === upd.question
        );
        if (!ans) continue;
        if (typeof upd.earnedPoints === 'number') {
          ans.earnedPoints = upd.earnedPoints;
        }
        if (typeof upd.teacherFeedback === 'string') {
          ans.teacherFeedback = upd.teacherFeedback;
        }
      }
      sub.totalScore = sub.answers.reduce((sum, a) => sum + a.earnedPoints, 0);
      await sub.save();
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

export default QuizSubmissionrouter;
