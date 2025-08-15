// src/grades/grades-router.js
import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";
import assignmentModel from "../assignment/assignmentModel.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import questionModel from "../question/question-model.js";
import AssignmentSubmissionModel from "../assignment/AssignmentSubmission-model.js";
import questionSubmissionModel from "../question/questionSubmission-model.js";
import groupSubmissionModel from "../assignment/groupSubmission-model.js";

const GradesRouter = express.Router();
const asId = (v) => (typeof v === "string" ? new mongoose.Types.ObjectId(v) : v);

// Simple status derivation
function deriveStatus({ exists, score }) {
  if (!exists) return "missing";
  return typeof score === "number" ? "graded" : "submitted";
}

/**
 * GET /grades/courseInstance/:id/gradebook
 * Items = Assignments, GroupAssignments (embedded groups), Questions
 * Grades resolution priority (group):
 *   1) GroupAssignmentSubmission.grade (if exists for that group)
 *   2) Fallback to GroupAssignment.groups[].marks
 */
GradesRouter.get(
  "/courseInstance/:id/gradebook",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const courseInstanceId = asId(req.params.id);

      // 1) Course + roster
      const instance = await CourseInstance.findById(courseInstanceId)
        .populate({ path: "batch", select: "_id name batchname" })
        .lean();

      if (!instance) return res.status(404).json({ error: "CourseInstance not found" });

      let roster = [];
      if (Array.isArray(instance.students) && instance.students.length) {
        roster = await User.find({ _id: { $in: instance.students } })
          .select("_id username email")
          .lean();
      } else if (instance.batch?._id) {
        roster = await User.find({ role: "student", batch: instance.batch._id })
          .select("_id username email")
          .lean();
      }

      // 2) Items (pull visibleTo for A/Q; groups for GA)
      const [assignments, groupAssignments, questions] = await Promise.all([
        assignmentModel
          .find({ courseInstance: courseInstanceId })
          .select("_id title points dueDate closeAt topic visibleTo") // NEW
          .lean(),
        groupAssignmentModel
          .find({ courseInstance: courseInstanceId })
          .select("_id title points dueDate closeAt topic groups") // groups -> members/marks
          .lean(),
        questionModel
          .find({ courseInstance: courseInstanceId })
          .select("_id title points topic dueDate visibleTo") // NEW
          .lean(),
      ]);

      const items = [
        ...assignments.map((a) => ({
          id: String(a._id),
          type: "assignment",
          title: a.title ?? "Assignment",
          maxPoints: typeof a.points === "number" ? a.points : 0,
          dueAt: a.dueDate ?? a.closeAt ?? null,
          topic: a.topic ?? null,
        })),
        ...groupAssignments.map((g) => ({
          id: String(g._id),
          type: "groupAssignment",
          title: g.title ?? "Group Assignment",
          maxPoints: typeof g.points === "number" ? g.points : 100,
          dueAt: g.dueDate ?? g.closeAt ?? null,
          topic: g.topic ?? null,
        })),
        ...questions.map((q) => ({
          id: String(q._id),
          type: "question",
          title: q.title ?? "Question",
          maxPoints: typeof q.points === "number" ? q.points : 0,
          dueAt: q.dueDate ?? null,
          topic: q.topic ?? null,
        })),
      ];

      // 3) Per-student submissions
      const [assignmentSubs, questionSubs] = await Promise.all([
        assignments.length
          ? AssignmentSubmissionModel.find({ assignment: { $in: assignments.map((a) => a._id) } })
              .select("_id assignment student grade submittedAt")
              .lean()
          : [],
        questions.length
          ? questionSubmissionModel.find({ question: { $in: questions.map((q) => q._id) } })
              .select("_id question student grade submittedAt")
              .lean()
          : [],
      ]);

      // 4) Group membership map (by GA) and eligible map
      // Map: gaId -> Map(groupId -> members[])
      const groupsByGA = new Map();
      for (const ga of groupAssignments) {
        const inner = new Map();
        for (const grp of ga.groups || []) {
          inner.set(String(grp._id), Array.isArray(grp.members) ? grp.members.map(String) : []);
        }
        groupsByGA.set(String(ga._id), inner);
      }

      // Load group submissions (if any)
      const gaIds = groupAssignments.map((g) => g._id);
      const groupSubs = gaIds.length
        ? await groupSubmissionModel
            .find({ groupAssignmentId: { $in: gaIds } })
            .select("_id groupAssignmentId groupId grade submittedAt")
            .lean()
        : [];

      // 5) If roster still empty, build from submissions + group members
      if (!roster.length) {
        const ids = new Set([
          ...assignmentSubs.map((s) => String(s.student)),
          ...questionSubs.map((s) => String(s.student)),
          ...groupAssignments.flatMap((ga) =>
            (ga.groups ?? []).flatMap((grp) =>
              Array.isArray(grp.members) ? grp.members.map(String) : []
            )
          ),
        ]);
        if (ids.size) {
          roster = await User.find({ _id: { $in: [...ids] } })
            .select("_id username email")
            .lean();
        }
      }

      const rosterIds = roster.map((u) => String(u._id));

      // 6) Build eligibility per item  // NEW
      // itemId -> Set(studentId)
      const eligibleByItem = new Map();

      // A) Assignments: visibleTo empty => all; else only those in visibleTo
      for (const a of assignments) {
        const id = String(a._id);
        const vt = Array.isArray(a.visibleTo) ? a.visibleTo.map(String) : [];
        eligibleByItem.set(id, new Set(vt.length ? vt : rosterIds));
      }

      // B) Questions: same rule as assignments
      for (const q of questions) {
        const id = String(q._id);
        const vt = Array.isArray(q.visibleTo) ? q.visibleTo.map(String) : [];
        eligibleByItem.set(id, new Set(vt.length ? vt : rosterIds));
      }

      // C) GroupAssignments: only members of any group in that GA
      for (const ga of groupAssignments) {
        const id = String(ga._id);
        const members = (ga.groups ?? []).flatMap((grp) =>
          Array.isArray(grp.members) ? grp.members.map(String) : []
        );
        eligibleByItem.set(id, new Set(members)); // if no members, nobody sees it
      }

      // Helper to check eligibility quickly
      const isEligible = (itemId, studentId) =>
        (eligibleByItem.get(itemId)?.has(studentId)) || false;

      // 7) Build grade cells (only for eligible pairs)
      const grades = [];

      // Assignments (submissions)
      for (const s of assignmentSubs) {
        const itemId = String(s.assignment);
        const studentId = String(s.student);
        if (!isEligible(itemId, studentId)) continue; // NEW
        const it = items.find((i) => i.type === "assignment" && i.id === itemId);
        const maxPoints = it?.maxPoints ?? 0;
        const score = typeof s.grade === "number" ? s.grade : null;

        grades.push({
          studentId,
          itemId,
          type: "assignment",
          score,
          maxPoints,
          status: deriveStatus({ exists: true, score }),
          gradedAt: s.submittedAt ?? null,
        });
      }

      // GroupAssignments — 1) Prefer submission grade (we already restrict to members)
      for (const sub of groupSubs) {
        const gaId = String(sub.groupAssignmentId);
        const grpId = String(sub.groupId);
        const members = groupsByGA.get(gaId)?.get(grpId) || [];
        const it = items.find((i) => i.type === "groupAssignment" && i.id === gaId);
        const maxPoints = it?.maxPoints ?? 0;
        const score = typeof sub.grade === "number" ? sub.grade : null;

        for (const studentId of members) {
          // members are inherently eligible
          grades.push({
            studentId,
            itemId: gaId,
            type: "groupAssignment",
            score,
            maxPoints,
            status: deriveStatus({ exists: members.length > 0, score }),
            gradedAt: sub.submittedAt ?? null,
          });
        }
      }

      // GroupAssignments — 2) Fallback to embedded groups[].marks where no submission exists
      for (const ga of groupAssignments) {
        const gaId = String(ga._id);
        const it = items.find((i) => i.type === "groupAssignment" && i.id === gaId);
        const maxPoints = it?.maxPoints ?? 0;

        for (const grp of ga.groups || []) {
          const grpId = String(grp._id);
          const hasSubmission = groupSubs.some(
            (s) => String(s.groupAssignmentId) === gaId && String(s.groupId) === grpId
          );
          if (hasSubmission) continue;

          const members = Array.isArray(grp.members) ? grp.members.map(String) : [];
          const score = typeof grp.marks === "number" ? grp.marks : null;

          for (const studentId of members) {
            grades.push({
              studentId,
              itemId: gaId,
              type: "groupAssignment",
              score,
              maxPoints,
              status: deriveStatus({ exists: members.length > 0, score }),
              gradedAt: null,
            });
          }
        }
      }

      // Questions (submissions)
      for (const s of questionSubs) {
        const itemId = String(s.question);
        const studentId = String(s.student);
        if (!isEligible(itemId, studentId)) continue; // NEW
        const it = items.find((i) => i.type === "question" && i.id === itemId);
        const maxPoints = it?.maxPoints ?? 0;
        const score = typeof s.grade === "number" ? s.grade : null;

        grades.push({
          studentId,
          itemId,
          type: "question",
          score,
          maxPoints,
          status: deriveStatus({ exists: true, score }),
          gradedAt: s.submittedAt ?? null,
        });
      }

      // 8) Fill "missing" ONLY for eligible (student,item) pairs  // NEW
      const itemIds = items.map((i) => i.id);
      const key = (sid, iid) => `${sid}__${iid}`;
      const have = new Set(grades.map((g) => key(g.studentId, g.itemId)));

      for (const sid of rosterIds) {
        for (const iid of itemIds) {
          if (!isEligible(iid, sid)) continue; // not visible -> skip entirely
          const k = key(sid, iid);
          if (!have.has(k)) {
            const it = items.find((x) => x.id === iid);
            grades.push({
              studentId: sid,
              itemId: iid,
              type: it?.type ?? "assignment",
              score: null,
              maxPoints: it?.maxPoints ?? 0,
              status: "missing",
              gradedAt: null,
            });
          }
        }
      }

      // 9) Summary (only counts eligible cells because we only created those)
      const totals = new Map(); // sid -> { earned, possible }
      for (const g of grades) {
        const t = totals.get(g.studentId) ?? { earned: 0, possible: 0 };
        if (g.maxPoints > 0) {
          t.possible += g.maxPoints;
          if (typeof g.score === "number") t.earned += g.score;
        }
        totals.set(g.studentId, t);
      }

      const percentages = rosterIds.map((sid) => {
        const t = totals.get(sid) ?? { earned: 0, possible: 0 };
        return t.possible > 0 ? (t.earned / t.possible) * 100 : 0;
      });

      const classAvg =
        percentages.length ? percentages.reduce((a, b) => a + b, 0) / percentages.length : 0;

      const median = (() => {
        const arr = [...percentages].sort((a, b) => a - b);
        if (!arr.length) return 0;
        const mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
      })();

      const totalCells = grades.length || 1;
      const submittedRate = grades.filter((g) => g.status !== "missing").length / totalCells;
      const gradedRate = grades.filter((g) => g.status === "graded").length / totalCells;

      return res.json({
        roster: roster.map((u) => ({ _id: u._id, username: u.username, email: u.email })),
        items,
        grades,
        policies: { scheme: "points", treatMissingAsZero: false },
        summary: { classAvg, median, submittedRate, gradedRate },
      });
    } catch (err) {
      console.error("gradebook error:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);


GradesRouter.patch(
  "/assignment/:assignmentId/student/:studentId",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { assignmentId, studentId } = req.params;
      const { score, feedback } = req.body || {};
      if (typeof score !== "number") {
        return res.status(400).json({ error: "score (number) is required" });
      }

      const doc = await AssignmentSubmissionModel.findOneAndUpdate(
        { assignment: asId(assignmentId), student: asId(studentId) },
        {
          $set: {
            grade: score,
            ...(typeof feedback === "string" ? { feedback } : {}),
            status: "submitted",
            submittedAt: new Date(),
          },
        },
        { new: true, upsert: true }
      );

      res.json({ ok: true, submission: doc });
    } catch (err) {
      console.error("assignment grade error:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

GradesRouter.patch(
  "/question/:questionId/student/:studentId",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { questionId, studentId } = req.params;
      const { score, feedback } = req.body || {};
      if (typeof score !== "number") {
        return res.status(400).json({ error: "score (number) is required" });
      }

      const doc = await questionSubmissionModel.findOneAndUpdate(
        { question: asId(questionId), student: asId(studentId) },
        {
          $set: {
            grade: score,
            ...(typeof feedback === "string" ? { feedback } : {}),
            status: "submitted",
            submittedAt: new Date(),
          },
        },
        { new: true, upsert: true }
      );

      res.json({ ok: true, submission: doc });
    } catch (err) {
      console.error("question grade error:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

GradesRouter.patch(
  "/group/:groupAssignmentId/group/:groupId",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { groupAssignmentId, groupId } = req.params;
      const { score, feedback } = req.body || {};
      if (typeof score !== "number") {
        return res.status(400).json({ error: "score (number) is required" });
      }

      const doc = await GroupAssignmentSubmission.findOneAndUpdate(
        { groupAssignmentId: asId(groupAssignmentId), groupId: asId(groupId) },
        {
          $set: {
            grade: score,
            ...(typeof feedback === "string" ? { feedback } : {}),
            status: "submitted",
            submittedAt: new Date(),
          },
        },
        { new: true, upsert: true }
      );

      res.json({ ok: true, submission: doc });
    } catch (err) {
      console.error("group submission grade error:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

/**
 * PATCH /grades/group/:groupAssignmentId/group/:groupId/embedded
 * Body: { score: number, feedback?: string }
 * Simple mode: directly set embedded groups.$.marks (no submission doc).
 */
GradesRouter.patch(
  "/group/:groupAssignmentId/group/:groupId/embedded",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { groupAssignmentId, groupId } = req.params;
      const { score, feedback } = req.body || {};
      if (typeof score !== "number") {
        return res.status(400).json({ error: "score (number) is required" });
      }

      const result = await GroupAssignment.updateOne(
        { _id: asId(groupAssignmentId), "groups._id": asId(groupId) },
        {
          $set: {
            "groups.$.marks": score,
            ...(typeof feedback === "string" ? { "groups.$.feedback": feedback } : {}),
          },
        }
      );

      if (result.matchedCount === 0 && result.modifiedCount === 0) {
        return res.status(404).json({ error: "Group or GroupAssignment not found" });
      }

      const updated = await GroupAssignment.findById(groupAssignmentId)
        .select("_id title points groups")
        .lean();

      res.json({ ok: true, groupAssignment: updated });
    } catch (err) {
      console.error("group embedded grade error:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

export default GradesRouter;
