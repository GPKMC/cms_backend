import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

import CourseInstance from "../course/courseinstance-model.js";

import assignmentModel from "../assignment/assignmentModel.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import questionModel from "../question/question-model.js";

import AssignmentSubmissionModel from "../assignment/assignmentSubmission-model.js";
import questionSubmissionModel from "../question/questionSubmission-model.js";
import groupSubmissionModel from "../assignment/groupSubmission-model.js";
import QuizSubmission from "../quizQuestion/submission-model.js";

const StudentProgressRouter = express.Router();

/* ---------------------------------
   Visibility helpers (robust)
---------------------------------- */

// For assignments & questions: visibleTo empty/missing => visible to all
function isVisibleToStudentByVisibleTo(doc, userId) {
  const vt = doc?.visibleTo;

  if (vt == null) return true;              // missing or null => public
  if (!Array.isArray(vt)) return true;      // unexpected shape => default allow
  if (vt.length === 0) return true;         // empty array => public

  // entries may be ObjectId or populated user docs
  return vt.some((v) => {
    const id = v?._id ?? v;
    return id && String(id) === String(userId);
  });
}

// For group assignments: student must be in at least one group
function isStudentInAnyGroup(gaDoc, userId) {
  const groups = gaDoc?.groups;
  if (!Array.isArray(groups)) return false;

  return groups.some((g) => {
    const members = g?.members || [];
    return members.some((m) => {
      // members could be:
      // - ObjectId of User
      // - subdoc { user: ObjectId }
      // - subdoc { user: PopulatedUser }
      // - populated user doc directly
      const candidate =
        m?.user?._id ??   // populated subdoc.user
        m?.user ??        // subdoc.user ObjectId
        m?._id ??         // populated user doc
        m;                // raw ObjectId
      return candidate && String(candidate) === String(userId);
    });
  });
}

StudentProgressRouter.get(
  "/student/progress",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { courseInstanceId, batch, semester } = req.query;

      // 1) Resolve course instances
      let courseInstances = [];
      if (courseInstanceId) {
        if (!mongoose.Types.ObjectId.isValid(courseInstanceId)) {
          return res.status(400).json({ error: "Invalid courseInstanceId" });
        }
        const ci = await CourseInstance.findById(courseInstanceId)
          .populate("course", "name code")
          .lean();
        if (!ci) return res.json({ meta: {}, items: [] });
        courseInstances = [ci];
      } else if (batch && semester) {
        // only if your schema has semester
        courseInstances = await CourseInstance.find({ batch, semester })
          .populate("course", "name code")
          .lean();
      } else {
        return res
          .status(400)
          .json({ error: "Provide courseInstanceId OR batch & semester" });
      }

      if (!courseInstances.length) return res.json({ meta: {}, items: [] });
      const ciIds = courseInstances.map((ci) => ci._id);

      // 2) Fetch all resource types
      const [
        assignmentsRaw,
        groupAssignmentsRaw,
        quizzesRaw,
        questionsRaw,
      ] = await Promise.all([
        assignmentModel
          .find({ courseInstance: { $in: ciIds } })
          .populate("topic", "title _id")
          .lean(),
        groupAssignmentModel
          .find({ courseInstance: { $in: ciIds } })
          .populate("topic", "title _id")
          // IMPORTANT: populate correct path for members.user if your schema uses it
          .populate("groups.members.user", "_id username role")
          .lean(),
        quizquestionModel
          .find({ courseInstance: { $in: ciIds } })
          .populate("topic", "title _id")
          .lean(),
        questionModel
          .find({ courseInstance: { $in: ciIds } })
          .populate("topic", "title _id")
          .lean(),
      ]);

      // 2b) Apply visibility
      const assignments = assignmentsRaw.filter((a) =>
        isVisibleToStudentByVisibleTo(a, userId)
      );

      const groupAssignments = groupAssignmentsRaw.filter((ga) =>
        isStudentInAnyGroup(ga, userId)
      );

      const quizzes = quizzesRaw; // always visible (per your rule)

      const questions = questionsRaw.filter((q) =>
        isVisibleToStudentByVisibleTo(q, userId)
      );

      // 3) Fetch this student's submissions
      const [aSubs, gaSubs, qzSubs, qaSubs] = await Promise.all([
        AssignmentSubmissionModel.find({
          student: userId,
          assignment: { $in: assignments.map((a) => a._id) },
        }).lean(),
        groupSubmissionModel.find({
          "members.user": userId, // submission model path
          groupAssignment: { $in: groupAssignments.map((g) => g._id) },
        }).lean(),
        QuizSubmission.find({
          student: userId,
          quiz: { $in: quizzes.map((q) => q._id) },
        }).lean(),
        questionSubmissionModel.find({
          student: userId,
          question: { $in: questions.map((q) => q._id) },
        }).lean(),
      ]);

      // Map submissions by target id
      const makeMap = (arr, key) => {
        const m = new Map();
        for (const s of arr) {
          const id = String(s[key]);
          if (!m.has(id)) m.set(id, []);
          m.get(id).push(s);
        }
        return m;
      };
      const aMap = makeMap(aSubs, "assignment");
      const gaMap = makeMap(gaSubs, "groupAssignment");
      const qzMap = makeMap(qzSubs, "quiz");
      const qaMap = makeMap(qaSubs, "question");

      // 4) Normalize and compute status
      const normalize = (arr, type) => {
        return arr.map((it) => {
          const ci = courseInstances.find(
            (c) => String(c._id) === String(it.courseInstance)
          );

          let subs = [];
          if (type === "assignment") subs = aMap.get(String(it._id)) || [];
          if (type === "groupAssignment") subs = gaMap.get(String(it._id)) || [];
          if (type === "quiz") subs = qzMap.get(String(it._id)) || [];
          if (type === "question") subs = qaMap.get(String(it._id)) || [];

          subs.sort(
            (x, y) =>
              new Date(y.updatedAt || y.createdAt) - new Date(x.updatedAt || x.createdAt)
          );
          const latest = subs[0];

          return {
            _id: it._id,
            type,
            title: it.title || it.name || "(Untitled)",
            topic: it.topic || null,
            dueDate: it.dueDate || null,
            courseInstance: ci
              ? {
                _id: ci._id,
                course: {
                  _id: ci.course?._id || null,
                  name: ci.course?.name || "",
                  code: ci.course?.code || "",
                },
                batch: ci.batch,
                semester: ci.semester,
              }
              : null,
            submitted: !!latest,
            submittedAt: latest
              ? (latest.submittedAt || latest.updatedAt || latest.createdAt)
              : null,
            score: latest && (latest.score ?? latest.marks ?? null),
            attemptCount: subs.length || 0,
            submissionId: latest?._id || null,
          };
        });
      };

      const items = [
        ...normalize(assignments, "assignment"),
        ...normalize(groupAssignments, "groupAssignment"),
        ...normalize(quizzes, "quiz"),
        ...normalize(questions, "question"),
      ].sort((a, b) => {
        const getWhen = (x) => new Date(x.submittedAt || x.dueDate || 0).getTime();
        return getWhen(b) - getWhen(a);
      });

      const submittedItems = items.filter((x) => x.submitted);
      const lastSubmittedAtDate = submittedItems.length
        ? new Date(
            Math.max(
              ...submittedItems.map((x) => new Date(x.submittedAt).getTime())
            )
          )
        : null;

      const singleCI = courseInstances.length === 1 ? courseInstances[0] : null;

      const meta = {
        courseInstances: ciIds,
        courseInstance: singleCI
          ? {
              _id: singleCI._id,
              name: singleCI.course?.name || "",
              code: singleCI.course?.code || "",
              batch: singleCI.batch,
              semester: singleCI.semester,
            }
          : undefined,
        total: items.length,
        submittedCount: submittedItems.length,
        pendingCount: items.length - submittedItems.length,
        lastSubmittedAt: lastSubmittedAtDate ? lastSubmittedAtDate.toISOString() : null,
        recent: submittedItems.slice(0, 5),
      };

      res.json({ meta, items });
    } catch (err) {
      console.error("student/progress error", err);
      res.status(500).json({ error: err.message || "Failed to load progress" });
    }
  }
);

export default StudentProgressRouter;
