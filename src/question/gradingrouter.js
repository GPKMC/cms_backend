import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import questionModel from "./question-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import questionSubmissionModel from "./questionSubmission-model.js";

const gradingRouter = express.Router();

/* ---------- helpers to normalize preview data ---------- */
function asArray(x) {
  return Array.isArray(x) ? x : [];
}
function pickAttachments(s) {
  const out = [];
  const candidates = [
    s.attachments,
    s.files,
    s.media,
    s.documents,
    s.answerFiles,
    s.uploads,
  ]
    .map(asArray)
    .filter((arr) => arr.length);

  for (const arr of candidates) {
    for (const f of arr) {
      if (!f) continue;
      if (typeof f === "string") out.push({ url: f });
      else
        out.push({
          url: f.url || f.path || f.location || "",
          originalname: f.originalname || f.name || f.filename,
          filetype: f.filetype || f.mimetype || f.type,
        });
    }
  }
  return out;
}
function pickSnippet(s) {
  return (
    s.snippet ||
    s.answerText || // << include the student's text answer
    s.textAnswer ||
    s.answer ||
    (typeof s.content === "string" ? s.content : undefined) ||
    s.extractedText ||
    s.combinedText ||
    undefined
  );
}

/* =========================================================
   GET /grading/question/:id/stats
========================================================= */
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

      const q = await questionModel.findById(id).lean();
      if (!q) return res.status(404).json({ error: "Question not found" });

      // roster
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

      // submissions for this question
      const subs = await questionSubmissionModel
        .find({ question: id })
        .select(
          [
            "_id",
            "student",
            "grade",
            "submittedAt",
            "updatedAt",
            "createdAt",
            "isReturned",
            "returnedAt",
            // attachments candidates
            "attachments",
            "files",
            "media",
            "documents",
            "answerFiles",
            "uploads",
            // text/snippet candidates
            "snippet",
            "answerText",
            "textAnswer",
            "answer",
            "content",
            "extractedText",
            "combinedText",
          ].join(" ")
        )
        .populate({ path: "student", select: "_id username name email avatarUrl" })
        .lean();

      // pick latest per student
      const latestByStudent = new Map(); // sid -> { s, t, atts, snip }
      for (const s of subs) {
        const sid = String(s.student?._id || s.student);
        const t = new Date(s.submittedAt || s.updatedAt || s.createdAt).getTime();
        const atts = pickAttachments(s);
        const snip = pickSnippet(s);
        const prev = latestByStudent.get(sid);
        if (!prev || t > prev.t) latestByStudent.set(sid, { s, t, atts, snip });
      }

      // rows for roster
      const rows = [];
      for (const st of rosterUsers) {
        const sid = String(st._id);
        const hit = latestByStudent.get(sid);
        rows.push({
          student: {
            _id: sid,
            username: st.username,
            name: st.name,
            email: st.email,
            avatarUrl: st.avatarUrl,
          },
          submitted: !!hit,
          returned: !!hit?.s?.isReturned,
          submissionId: hit?.s?._id ? String(hit.s._id) : null,
          submittedAt:
            hit?.s?.submittedAt || hit?.s?.updatedAt || hit?.s?.createdAt || null,
          grade: hit?.s?.grade ?? null,
          attachments: hit?.atts || [],
          snippet: hit?.snip,
        });
      }

      // submitters not in roster
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
            attachments: pickAttachments(s),
            snippet: pickSnippet(s),
          });
        }
      }

      const gradedCount = rows.filter((r) => r.submitted && r.returned).length;
      const turnedInCount = rows.filter((r) => r.submitted && !r.returned).length;
      const rosterCount = rows.length;
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

/* =========================================================
   PATCH /grading/question/:id/accepting  { accepting: boolean }
========================================================= */
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

/* =========================================================
   POST /grading/question/:id/return   { submissionIds: string[] }
========================================================= */
gradingRouter.post(
  "/question/:id/return",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { submissionIds = [] } = req.body || {};
      if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
        return res.json({ ok: true, modified: 0 });
      }

      const r = await questionSubmissionModel.updateMany(
        { _id: { $in: submissionIds }, question: id },
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

/* =========================================================
   POST /grading/question/:id/unreturn   { submissionIds: string[] }
========================================================= */
gradingRouter.post(
  "/question/:id/unreturn",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { submissionIds = [] } = req.body || {};
      if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
        return res.json({ ok: true, modified: 0 });
      }

      const r = await questionSubmissionModel.updateMany(
        { _id: { $in: submissionIds }, question: id },
        { $set: { isReturned: false }, $unset: { returnedAt: 1 } },
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
