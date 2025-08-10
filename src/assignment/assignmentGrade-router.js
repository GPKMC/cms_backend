// routes/teacher-assignment.routes.js
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import Assignment from "../assignment/assignmentModel.js"; // <-- path to your Assignment model
import Submission from "../assignment/AssignmentSubmission-model.js"; // <-- path to your Submission model
import User from "../users/user-model.js";

const assignmentGradeRouter = express.Router();

/**
 * PATCH /teacher/assignments/:assignmentId/accepting
 * Toggle acceptingSubmissions and/or set closeAt.
 * Body: { acceptingSubmissions?: boolean, closeAt?: string|null, closeNow?: boolean }
 */
assignmentGradeRouter.patch(
  "/assignments/:assignmentId/accepting",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { assignmentId } = req.params;
      const { acceptingSubmissions, closeAt, closeNow } = req.body;

      const assignment = await Assignment.findById(assignmentId);
      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found." });
      }

      if (typeof acceptingSubmissions === "boolean") {
        assignment.acceptingSubmissions = acceptingSubmissions;
      }

      if (closeNow === true) {
        assignment.acceptingSubmissions = false;
        assignment.closeAt = new Date();
      } else if (closeAt !== undefined) {
        // allow null to clear, or ISO date string to set
        assignment.closeAt = closeAt ? new Date(closeAt) : null;
      }

      await assignment.save();

      return res.status(200).json({
        message: "Assignment submission settings updated.",
        assignment: {
          _id: assignment._id,
          acceptingSubmissions: assignment.acceptingSubmissions,
          closeAt: assignment.closeAt,
          title: assignment.title,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * GET /teacher/assignments/:assignmentId/submissions
 * List all submissions for an assignment (teacher view)
 * Includes files, student info, plagiarism %, submittedAt, etc.
 */
assignmentGradeRouter.get(
  "/assignments/:assignmentId/submissions",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { assignmentId } = req.params;
      const includeDrafts = String(req.query.includeDrafts || "0") === "1";

      // 1) Load assignment + courseInstance (we need batch)
      const assignment = await Assignment.findById(assignmentId)
        .select("title acceptingSubmissions closeAt dueDate points courseInstance")
        .populate({
          path: "courseInstance",
          select: "batch course", // include what you need
        });

      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found." });
      }

      // 2) Pull all real submissions for this assignment
      const subQuery = { assignment: assignmentId };
      if (!includeDrafts) subQuery.status = "submitted";

      const submissions = await Submission.find(subQuery)
        .select("student files submittedAt grade feedback plagiarismPercentage plagiarismDetails status")
        .populate("student", "username email batch")
        .sort({ submittedAt: 1 });

      // 3) If includeDrafts=1, also attach "assigned" students (no submission yet)
      let merged = submissions;

      if (includeDrafts) {
        const batchId = assignment.courseInstance?.batch || null;

        // If batch exists, fetch all students in that batch
        let batchStudents = [];
        if (batchId) {
          batchStudents = await User.find({ role: "student", batch: batchId })
            .select("_id username email batch");
        }

        // Build a map of studentId -> submission (if any)
        const subByStudent = new Map(
          submissions.map(s => [String(s.student?._id || ""), s])
        );

        // Create synthetic "assigned" entries for students with no submission
        const assignedOnly = batchStudents
          .filter(stu => !subByStudent.has(String(stu._id)))
          .map(stu => ({
            // no real submission _id; you can send a synthetic one so the UI can select it,
            // but make sure your UI doesn't try to grade it.
            _id: `assigned:${stu._id}`,
            student: {
              _id: stu._id,
              username: stu.username,
              email: stu.email,
            },
            files: [],
            submittedAt: null,
            grade: null,
            feedback: "",
            plagiarismPercentage: 0,
            status: "assigned",
          }));

        merged = [...assignedOnly, ...submissions];
      }

      return res.status(200).json({
        assignment: {
          _id: assignment._id,
          title: assignment.title,
          points: assignment.points,
          acceptingSubmissions: assignment.acceptingSubmissions,
          closeAt: assignment.closeAt,
        },
        count: merged.length,
        submissions: merged,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * GET /teacher/submissions/:submissionId
 * Teacher view a single submission (all details)
 */
assignmentGradeRouter.get(
  "/submissions/:submissionId",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { submissionId } = req.params;

      const submission = await Submission.findById(submissionId)
        .populate("student", "username email")
        .populate("assignment", "title points dueDate acceptingSubmissions closeAt")
        .select(
          "files combinedText submittedAt grade feedback plagiarismPercentage plagiarismDetails status"
        );

      if (!submission) {
        return res.status(404).json({ error: "Submission not found." });
      }

      return res.status(200).json({ submission });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * PATCH /teacher/submissions/:submissionId/grade
 * Grade & feedback a submission
 * Body: { grade?: number, feedback?: string }
 */
assignmentGradeRouter.patch(
  "/submissions/:submissionId/grade",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { submissionId } = req.params;
      const { grade, feedback } = req.body;

      const submission = await Submission.findById(submissionId)
        .populate("assignment", "points");

      if (!submission) {
        return res.status(404).json({ error: "Submission not found." });
      }

      if (grade !== undefined) {
        const max = submission.assignment?.points ?? null;
        if (typeof grade !== "number" || Number.isNaN(grade)) {
          return res.status(400).json({ error: "Grade must be a number." });
        }
        if (max != null && (grade < 0 || grade > max)) {
          return res
            .status(400)
            .json({ error: `Grade must be between 0 and ${max}.` });
        }
        submission.grade = grade;
      }

      if (feedback !== undefined) {
        submission.feedback = String(feedback);
      }

      await submission.save();

      return res.status(200).json({
        message: "Submission graded.",
        submission: {
          _id: submission._id,
          grade: submission.grade,
          feedback: submission.feedback,
          plagiarismPercentage: submission.plagiarismPercentage,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

export default assignmentGradeRouter;
