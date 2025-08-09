import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import questionModel from "./question-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import questionSubmissionModel from "./questionSubmission-model.js";

const gradingRouter = express.Router();

/**
 * GET /grading/question/:id/stats
 * Returns roster + latest submission state broken into:
 * - assigned (no submission)
 * - turned in (submitted, not returned)
 * - graded (returned)
 */
gradingRouter.get(
  "/question/:id/stats",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid question id" });
      }

      // 1) Question
      const q = await questionModel.findById(id).lean();
      if (!q) return res.status(404).json({ error: "Question not found" });

      // 2) Build roster: all students in the CI batch (adjust if you store roster differently)
      let rosterUsers = [];
      if (q.courseInstance) {
        const ci = await CourseInstance.findById(q.courseInstance)
          .select("batch")
          .lean();
        if (ci?.batch) {
          rosterUsers = await User.find(
            { role: "student", batch: ci.batch },
            "_id username name email avatarUrl"
          ).lean();
        }
      }

      // 3) Submissions for this question
      const subs = await questionSubmissionModel
        .find({ question: id })
        .select("_id student grade submittedAt updatedAt createdAt isReturned")
        .populate({ path: "student", select: "_id username name email avatarUrl" })
        .lean();

      // Keep last submission per student
      const latestByStudent = new Map();
      for (const s of subs) {
        const sid = String(s.student?._id || s.student);
        const t = new Date(s.submittedAt || s.updatedAt || s.createdAt).getTime();
        const prev = latestByStudent.get(sid);
        if (!prev || t > prev.t) latestByStudent.set(sid, { s, t });
      }

      // 4) Rows (one per roster student)
      const rows = [];
      for (const st of rosterUsers) {
        const sid = String(st._id);
        const hit = latestByStudent.get(sid)?.s;
        rows.push({
          student: {
            _id: sid,
            username: st.username,
            name: st.name,
            email: st.email,
            avatarUrl: st.avatarUrl,
          },
          submitted: !!hit,
          returned: !!hit?.isReturned,
          submissionId: hit?._id ? String(hit._id) : null,
          submittedAt: hit?.submittedAt || hit?.updatedAt || hit?.createdAt || null,
          grade: hit?.grade ?? null,
          attachments: [],
          snippet: undefined,
        });
      }

      // 5) (edge case) submitters not present in roster
      for (const s of subs) {
        const sid = String(s.student?._id || s.student);
        if (!rows.find((r) => r.student._id === sid)) {
          rows.push({
            student: {
              _id: sid,
              username: s.student?.username,
              name: s.student?.name,
              email: s.student?.email,
              avatarUrl: s.student?.avatarUrl,
            },
            submitted: true,
            returned: !!s.isReturned,
            submissionId: String(s._id),
            submittedAt: s.submittedAt || s.updatedAt || s.createdAt || null,
            grade: s.grade ?? null,
            attachments: [],
          });
        }
      }

      const gradedCount   = rows.filter((r) => r.submitted && r.returned).length;
      const turnedInCount = rows.filter((r) => r.submitted && !r.returned).length;
      const rosterCount   = rows.length;
      const assignedCount = Math.max(rosterCount - (gradedCount + turnedInCount), 0);

      res.json({
        questionId: String(q._id),
        title: q.title ?? "Question",
        maxPoints: q.points ?? 100,
        acceptingSubmissions: q.acceptingSubmissions ?? true,
        assignedCount,
        turnedInCount,
        gradedCount,
        rows,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * PATCH /grading/question/:id/accepting  { accepting: boolean }
 */
gradingRouter.patch(
  "/question/:id/accepting",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { accepting } = req.body ?? {};
      const q = await questionModel
        .findByIdAndUpdate(
          id,
          { $set: { acceptingSubmissions: !!accepting } },
          { new: true }
        )
        .lean();
      if (!q) return res.status(404).json({ error: "Question not found" });
      res.json({ ok: true, acceptingSubmissions: q.acceptingSubmissions ?? true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * POST /grading/question/:id/return  { submissionIds: string[] }
 * Sets isReturned = true (and returnedAt if you want)
 */
gradingRouter.post(
  "/question/:id/return",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { submissionIds = [] } = req.body || {};
      if (!submissionIds.length) return res.json({ ok: true, modified: 0 });

      const r = await questionSubmissionModel.updateMany(
        { _id: { $in: submissionIds } },
        { $set: { isReturned: true, returnedAt: new Date() } },
        { strict: false }
      );

      res.json({ ok: true, modified: r.modifiedCount || 0 });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default gradingRouter;
