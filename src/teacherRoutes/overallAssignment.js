// ADD/REPLACE IN: src/grades/grades-router.js

import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";

// Item models
import Assignment from "../assignment/assignmentModel.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import questionModel from "../question/question-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";

// Submission models
import AssignmentSubmission from "../assignment/AssignmentSubmission-model.js";
import GroupAssignmentSubmission from "../assignment/groupSubmission-model.js";
import QuestionSubmission from "../question/questionSubmission-model.js";
import QuizSubmission from "../quizQuestion/submission-model.js";

const teacherAssignmentRouter = express.Router();
const asId = (v) => (typeof v === "string" ? new mongoose.Types.ObjectId(v) : v);

teacherAssignmentRouter.get(
  "/teacher/:teacherId/items",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { teacherId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(teacherId)) {
        return res.status(400).json({ error: "Invalid teacherId" });
      }
      const tId = asId(teacherId);

      const isAdmin = ["admin", "superadmin"].includes(req.user?.role);
      if (!isAdmin && String(req.user?._id) !== String(teacherId)) {
        return res.status(403).json({ error: "Not authorized for this teacher" });
      }

      // NOTE: select + populate course so we can surface a readable name
      const instances = await CourseInstance.find({
        $or: [{ teacher: tId }, { teachers: tId }, { instructors: tId }],
      })
        .select("_id batch students course")
        .populate({ path: "batch", select: "_id name batchname" })
        .populate({
          path: "course",
          select: "_id name title code shortName short_code courseName",
        })
        .lean();

      if (!instances.length) {
        return res.json({
          teacherId,
          courseInstances: [],
          rosterSizeByCI: {},
          courseLabelByCI: {},
          items: [],
          totals: { items: 0, assigned: 0, submitted: 0, graded: 0 },
        });
      }

      const ciIds = instances.map((ci) => ci._id.toString());

      // Build map of human-friendly course labels per CI
      const labelFromCourse = (c) =>
        c?.name ||
        c?.courseName ||
        c?.title ||
        c?.code ||
        c?.shortName ||
        c?.short_code ||
        (c?._id ? String(c._id) : "Course");

      const courseLabelByCI = {};
      for (const ci of instances) {
        courseLabelByCI[ci._id.toString()] = labelFromCourse(ci.course);
      }

      // ----- roster per CI (prefer explicit students array; else batch)
      const batchIdSet = new Set(
        instances
          .filter(
            (ci) => (!Array.isArray(ci.students) || ci.students.length === 0) && ci.batch?._id
          )
          .map((ci) => ci.batch._id.toString())
      );

      const studentsByBatch = batchIdSet.size
        ? await User.find({ role: "student", batch: { $in: [...batchIdSet].map(asId) } })
            .select("_id batch")
            .lean()
        : [];

      const batchToStudentIds = new Map();
      for (const s of studentsByBatch) {
        const b = s.batch?.toString?.();
        if (!b) continue;
        if (!batchToStudentIds.has(b)) batchToStudentIds.set(b, []);
        batchToStudentIds.get(b).push(s._id.toString());
      }

      const rosterSetByCI = new Map(); // ciId -> Set(studentId)
      const rosterSizeByCI = {};
      for (const ci of instances) {
        const cid = ci._id.toString();
        let ids = [];
        if (Array.isArray(ci.students) && ci.students.length) {
          ids = ci.students.map((x) => x.toString());
        } else if (ci.batch?._id) {
          ids = batchToStudentIds.get(ci.batch._id.toString()) || [];
        }
        const set = new Set(ids);
        rosterSetByCI.set(cid, set);
        rosterSizeByCI[cid] = set.size;
      }

      const typeParam = (req.query.types || "").toString().trim();
      const types = new Set(
        (typeParam ? typeParam.split(",") : ["assignment", "groupAssignment", "question", "quiz"])
          .map((t) => t.trim())
          .filter(Boolean)
      );

      const items = {
        assignments: [],
        groupAssignments: [],
        questions: [],
        quizzes: [],
      };

      if (types.has("assignment")) {
        items.assignments = await Assignment.find({ courseInstance: { $in: ciIds.map(asId) } })
          .select("_id title points dueDate closeAt topic visibleTo courseInstance")
          .lean();
      }
      if (types.has("groupAssignment")) {
        items.groupAssignments = await groupAssignmentModel
          .find({ courseInstance: { $in: ciIds.map(asId) } })
          .select("_id title points dueDate closeAt topic groups courseInstance")
          .lean();
      }
      if (types.has("question")) {
        items.questions = await questionModel
          .find({ courseInstance: { $in: ciIds.map(asId) } })
          .select("_id title points dueDate topic visibleTo courseInstance")
          .lean();
      }
      if (types.has("quiz")) {
        items.quizzes = await quizquestionModel
          .find({ courseInstance: { $in: ciIds.map(asId) } })
          .select("_id title points dueDate topic visibleTo courseInstance")
          .lean();
      }

      const countAssignedFromVisibleTo = (visibleTo, ciRosterSet) => {
        if (!ciRosterSet) return 0;
        if (Array.isArray(visibleTo) && visibleTo.length) {
          let cnt = 0;
          for (const v of visibleTo) if (ciRosterSet.has(v.toString())) cnt++;
          return cnt;
        }
        return ciRosterSet.size;
      };

      const assigned = {
        assignments: new Map(),
        questions: new Map(),
        quizzes: new Map(),
        groupAssignments: new Map(),
        groupMembersByGA: new Map(),
      };

      for (const a of items.assignments) {
        const cid = a.courseInstance?.toString?.() || "";
        assigned.assignments.set(
          a._id.toString(),
          countAssignedFromVisibleTo(a.visibleTo || [], rosterSetByCI.get(cid))
        );
      }
      for (const q of items.questions) {
        const cid = q.courseInstance?.toString?.() || "";
        assigned.questions.set(
          q._id.toString(),
          countAssignedFromVisibleTo(q.visibleTo || [], rosterSetByCI.get(cid))
        );
      }
      for (const z of items.quizzes) {
        const cid = z.courseInstance?.toString?.() || "";
        assigned.quizzes.set(
          z._id.toString(),
          countAssignedFromVisibleTo(z.visibleTo || [], rosterSetByCI.get(cid))
        );
      }

      for (const ga of items.groupAssignments) {
        const gaId = ga._id.toString();
        const cid = ga.courseInstance?.toString?.() || "";
        const ciRoster = rosterSetByCI.get(cid);

        const groupMap = new Map();
        const uniq = new Set();
        for (const g of ga.groups || []) {
          const gid = g._id?.toString?.() || "";
          const memSet = new Set();
          for (const m of g.members || []) {
            const mid = m.toString();
            if (ciRoster?.has(mid)) {
              memSet.add(mid);
              uniq.add(mid);
            }
          }
          if (gid) groupMap.set(gid, memSet);
        }
        assigned.groupAssignments.set(gaId, uniq.size);
        assigned.groupMembersByGA.set(gaId, groupMap);
      }

      const result = [];

      if (items.assignments.length) {
        const ids = items.assignments.map((d) => d._id);
        const agg = await AssignmentSubmission.aggregate([
          { $match: { assignment: { $in: ids }, status: "submitted" } },
          {
            $group: {
              _id: "$assignment",
              students: { $addToSet: "$student" },
              graded: { $sum: { $cond: [{ $ne: ["$grade", null] }, 1, 0] } },
            },
          },
          { $project: { submittedCount: { $size: "$students" }, gradedCount: "$graded" } },
        ]);
        const byId = new Map(agg.map((r) => [r._id.toString(), r]));
        for (const d of items.assignments) {
          const id = d._id.toString();
          const a = byId.get(id);
          const assignedCount = assigned.assignments.get(id) || 0;
          result.push({
            id,
            type: "assignment",
            title: d.title ?? "Assignment",
            courseInstanceId: d.courseInstance?.toString?.() || null,
            maxPoints: typeof d.points === "number" ? d.points : 0,
            topic: d.topic ?? null,
            dueAt: d.dueDate || d.closeAt || null,
            assignedCount,
            submittedCount: a?.submittedCount || 0,
            gradedCount: a?.gradedCount || 0,
            submissionRate: assignedCount > 0 ? (a?.submittedCount || 0) / assignedCount : 0,
          });
        }
      }

      if (items.questions.length) {
        const ids = items.questions.map((d) => d._id);
        const agg = await QuestionSubmission.aggregate([
          { $match: { question: { $in: ids }, status: "submitted" } },
          {
            $group: {
              _id: "$question",
              students: { $addToSet: "$student" },
              graded: { $sum: { $cond: [{ $ne: ["$grade", null] }, 1, 0] } },
            },
          },
          { $project: { submittedCount: { $size: "$students" }, gradedCount: "$graded" } },
        ]);
        const byId = new Map(agg.map((r) => [r._id.toString(), r]));
        for (const d of items.questions) {
          const id = d._id.toString();
          const a = byId.get(id);
          const assignedCount = assigned.questions.get(id) || 0;
          result.push({
            id,
            type: "question",
            title: d.title ?? "Question",
            courseInstanceId: d.courseInstance?.toString?.() || null,
            maxPoints: typeof d.points === "number" ? d.points : 0,
            topic: d.topic ?? null,
            dueAt: d.dueDate || null,
            assignedCount,
            submittedCount: a?.submittedCount || 0,
            gradedCount: a?.gradedCount || 0,
            submissionRate: assignedCount > 0 ? (a?.submittedCount || 0) / assignedCount : 0,
          });
        }
      }

      if (items.groupAssignments.length) {
        const ids = items.groupAssignments.map((d) => d._id);
        const agg = await GroupAssignmentSubmission.aggregate([
          { $match: { groupAssignmentId: { $in: ids }, status: "submitted" } },
          {
            $group: {
              _id: "$groupAssignmentId",
              groups: { $addToSet: "$groupId" },
              gradedGroups: { $sum: { $cond: [{ $ne: ["$grade", null] }, 1, 0] } },
            },
          },
        ]);
        const byId = new Map(agg.map((r) => [r._id.toString(), r]));

        for (const d of items.groupAssignments) {
          const id = d._id.toString();
          const row = byId.get(id);
          const assignedCount = assigned.groupAssignments.get(id) || 0;

          let submittedStudentCount = 0;
          let submittedGroupCount = 0;

          if (row) {
            submittedGroupCount = (row.groups || []).length;
            const groupMap = assigned.groupMembersByGA.get(id) || new Map();
            const uniq = new Set();
            for (const gid of row.groups || []) {
              const set = groupMap.get(gid.toString());
              if (set) for (const mid of set) uniq.add(mid);
            }
            submittedStudentCount = uniq.size;
          }

          result.push({
            id,
            type: "groupAssignment",
            title: d.title ?? "Group Assignment",
            courseInstanceId: d.courseInstance?.toString?.() || null,
            maxPoints: typeof d.points === "number" ? d.points : 0,
            topic: d.topic ?? null,
            dueAt: d.dueDate || d.closeAt || null,
            assignedCount,
            submittedCount: submittedStudentCount,
            submittedGroupCount,
            gradedGroupCount: row?.gradedGroups || 0,
            submissionRate: assignedCount > 0 ? submittedStudentCount / assignedCount : 0,
          });
        }
      }

      if (items.quizzes.length) {
        const ids = items.quizzes.map((d) => d._id);
        const agg = await QuizSubmission.aggregate([
          { $match: { quiz: { $in: ids }, status: "submitted" } },
          {
            $group: {
              _id: "$quiz",
              students: { $addToSet: "$student" },
              graded: { $sum: { $cond: [{ $gt: ["$totalScore", 0] }, 1, 0] } },
            },
          },
          { $project: { submittedCount: { $size: "$students" }, gradedCount: "$graded" } },
        ]);
        const byId = new Map(agg.map((r) => [r._id.toString(), r]));
        for (const d of items.quizzes) {
          const id = d._id.toString();
          const a = byId.get(id);
          const assignedCount = assigned.quizzes.get(id) || 0;
          result.push({
            id,
            type: "quiz",
            title: d.title ?? "Quiz",
            courseInstanceId: d.courseInstance?.toString?.() || null,
            maxPoints: typeof d.points === "number" ? d.points : 0,
            topic: d.topic ?? null,
            dueAt: d.dueDate || null,
            assignedCount,
            submittedCount: a?.submittedCount || 0,
            gradedCount: a?.gradedCount || 0,
            submissionRate: assignedCount > 0 ? (a?.submittedCount || 0) / assignedCount : 0,
          });
        }
      }

      result.sort((a, b) => {
        const at = a.dueAt ? new Date(a.dueAt).getTime() : 0;
        const bt = b.dueAt ? new Date(b.dueAt).getTime() : 0;
        return bt - at;
      });

      const totals = result.reduce(
        (acc, it) => {
          acc.items++;
          acc.assigned += it.assignedCount || 0;
          acc.submitted += it.submittedCount || 0;
          acc.graded += it.gradedCount || it.gradedGroupCount || 0;
          return acc;
        },
        { items: 0, assigned: 0, submitted: 0, graded: 0 }
      );

      return res.json({
        teacherId,
        courseInstances: ciIds,
        rosterSizeByCI,
        courseLabelByCI, // <<—— added
        items: result,
        totals,
      });
    } catch (err) {
      console.error("teacher/:teacherId/items error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

export default teacherAssignmentRouter;
