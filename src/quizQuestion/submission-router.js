// quizQuestion/submission-router.js
import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import QuizSubmission from './submission-model.js';
import QuizQuestion from './quizquestion-model.js';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';

const QuizSubmissionrouter = express.Router();

function validate(req, res, next) {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
}

async function ensureOwnerOrTeacher(req, res, next) {
  try {
    const sub = await QuizSubmission.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'Submission not found' });
    if (req.user.role === 'student' && String(sub.student) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    req.submission = sub;
    next();
  } catch (err) {
    next(err);
  }
}

/** Start (or fetch) a submission */
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
      let submission = await QuizSubmission.findOne({ quiz, student });
      if (submission) {
        return res.status(200).json({ message: 'Already started', submission });
      }
      submission = await QuizSubmission.create({ quiz, student }); // defaults: status: 'draft'
      return res.status(201).json(submission);
    } catch (err) {
      if (err?.code === 11000) {
        const dup = await QuizSubmission.findOne({ quiz, student });
        return res.status(200).json({ submission: dup });
      }
      next(err);
    }
  }
);

/** List submissions (teacher or student) */
// routes/quizSubmissionRouter.js  (only this handler changed)
QuizSubmissionrouter.get(
  '/',
  authmiddleware,
  authorizedRole('student', 'teacher'),
  [
    query('quiz').optional().isMongoId(),
    query('studentId').optional().isMongoId(),
    query('status').optional().isIn(['draft', 'submitted']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { quiz, studentId, status } = req.query;
      const filter = {};
      if (quiz) filter.quiz = quiz;
      if (status) filter.status = status;

      if (req.user.role === 'student') {
        filter.student = req.user.id; // student can only see their own
      } else if (studentId) {
        filter.student = studentId;
      }

      const items = await QuizSubmission.find(filter)
        .select('_id quiz student status totalScore submittedAt createdAt updatedAt')
        .populate('student', 'username email')   // ← add this
        .lean();

      res.json(items);
    } catch (err) {
      next(err);
    }
  }
);


/** Stats for a quiz (teacher) */
QuizSubmissionrouter.get(
  '/stats',
  authmiddleware,
  authorizedRole('teacher'),
  [query('quizId').isMongoId().withMessage('quizId is required')],
  validate,
  async (req, res, next) => {
    try {
      const { quizId } = req.query;
      const [submittedCount, startedCount] = await Promise.all([
        QuizSubmission.countDocuments({ quiz: quizId, status: 'submitted' }),
        QuizSubmission.countDocuments({ quiz: quizId }),
      ]);
      res.json({ submittedCount, startedCount });
    } catch (err) {
      next(err);
    }
  }
);

/** Get a single submission (safe for students pre-submit) */
QuizSubmissionrouter.get(
  '/:id',
  authmiddleware,
  authorizedRole('student', 'teacher'),
  param('id').isMongoId().withMessage('Invalid submission id'),
  validate,
  ensureOwnerOrTeacher,
  async (req, res, next) => {
    try {
      const subDoc = req.submission.toObject();
      const quiz = await QuizQuestion.findById(subDoc.quiz).lean();
      if (!quiz) return res.status(500).json({ message: 'Quiz not found' });

      // Hide correct answers for students until submitted
      const hideCorrect = (req.user.role === 'student' && subDoc.status !== 'submitted');
      if (hideCorrect && Array.isArray(quiz.questions)) {
        quiz.questions = quiz.questions.map(q => {
          const { correctOption, ...rest } = q; // strip
          return rest;
        });
      }

      const answers = (subDoc.answers || []).map((ans) => {
        const question =
          (quiz.questions || []).find(q => String(q._id) === String(ans.question)) || null;
        return { ...ans, question };
      });

      res.json({ ...subDoc, quiz, answers });
    } catch (err) {
      next(err);
    }
  }
);

/** Update answers (draft) */
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

/** Final submit: autoscore */
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

      const quizDoc = await QuizQuestion.findById(sub.quiz);
      if (!quizDoc) return res.status(500).json({ message: 'Quiz not found for scoring' });

      let total = 0;
      sub.answers = (sub.answers || []).map((ans) => {
        const q = (quizDoc.questions || []).find(
          (qq) => String(qq._id) === String(ans.question)
        );
        const earned = q && String(ans.selectedOption) === String(q.correctOption) ? q.points : 0;
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

/** Teacher feedback / override points */
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
        const ans = sub.answers.find((a) => String(a.question) === String(upd.question));
        if (!ans) continue;
        if (typeof upd.earnedPoints === 'number') ans.earnedPoints = upd.earnedPoints;
        if (typeof upd.teacherFeedback === 'string') ans.teacherFeedback = upd.teacherFeedback;
      }
      sub.totalScore = sub.answers.reduce((sum, a) => sum + (a.earnedPoints || 0), 0);
      await sub.save();
      res.json(sub);
    } catch (err) {
      next(err);
    }
  }
);

export default QuizSubmissionrouter;
