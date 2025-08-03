import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import questionSubmissionModel from "../question/questionSubmission-model.js";

const Submissionrouter = express.Router();

// Multer storage config for dynamic folder by assignment type
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const assignmentType = req.body.assignment_type || "default";
    const uploadPath = path.join(process.cwd(), ".uploads", `${assignmentType}Submission`);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

// POST /api/submit-assignment
Submissionrouter.post("/submit-assignment", upload.array("files"), async (req, res) => {
  try {
    const {
      student_id,
      text_input,
      assignment_type,
      assignment_id,
      question_id,
      group_id,
    } = req.body;

    // Always make req.files safe (even if empty)
    const files = Array.isArray(req.files) ? req.files : [];

    if (!student_id) {
      return res.status(400).json({ error: "student_id is required" });
    }

    // --- 1. Submission limiting rules (optional, skip if not using models) ---
    if (assignment_type === "assignment") {
      const already = await assignmentSubmissionModel.exists({
        assignment: assignment_id,
        student: student_id,
      });
      if (already) {
        for (const file of files) fs.unlink(file.path, () => {});
        return res
          .status(409)
          .json({ error: "You have already submitted this assignment." });
      }
    }

    if (assignment_type === "question") {
      const already = await questionSubmissionModel.exists({
        question: question_id,
        student: student_id,
      });
      if (already) {
        for (const file of files) fs.unlink(file.path, () => {});
        return res
          .status(409)
          .json({ error: "You have already submitted for this question." });
      }
    }

    if (assignment_type === "groupassignment") {
      if (!group_id) {
        for (const file of files) fs.unlink(file.path, () => {});
        return res
          .status(400)
          .json({ error: "group_id is required for group assignment." });
      }
      const group = await groupAssignmentModel.findOne({
        _id: assignment_id,
        "groups._id": group_id,
        "groups.submissions.0": { $exists: true },
      });
      if (group) {
        for (const file of files) fs.unlink(file.path, () => {});
        return res
          .status(409)
          .json({ error: "Your group has already submitted." });
      }
    }

    // --- 2. Prepare form-data for FastAPI ---
    const form = new FormData();
    for (const file of files) {
      form.append("files", fs.createReadStream(file.path), file.originalname);
    }
    form.append("student_id", student_id);
    if (text_input) form.append("text_input", text_input);
    if (assignment_type) form.append("assignment_type", assignment_type);
    if (assignment_id) form.append("assignment_id", assignment_id);
    if (question_id) form.append("question_id", question_id);
    if (group_id) form.append("group_id", group_id);

    // --- 3. Call FastAPI plagiarism endpoint ---
    const response = await axios.post(
      "http://localhost:8000/check-plagiarism",
      form,
      {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    // --- 4. Cleanup uploaded files (if any) ---
    for (const file of files) {
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting temp file:", file.path, err);
      });
    }

    // --- 5. Return FastAPI result to frontend ---
    return res.json(response.data);

  } catch (error) {
    console.error("Error in submit-assignment:", error && (error.stack || error.message || error));
    return res.status(500).json({ error: "Failed to process submission" });
  }
});


Submissionrouter.delete(
  "/:groupassignmentId/group/:groupId",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { groupassignmentId, groupId } = req.params;

      // Fetch assignment
      const assignment = await groupAssignmentModel.findById(groupassignmentId);
      if (!assignment) return res.status(404).json({ error: "Assignment not found." });

      // Check due date
      if (assignment.dueDate && new Date() > new Date(assignment.dueDate)) {
        return res.status(403).json({ error: "Cannot undo. Assignment is overdue." });
      }

      // Find group
      const group = assignment.groups.find(g => g._id.toString() === groupId);
      if (!group) return res.status(404).json({ error: "Group not found in assignment." });

      // Optional: Only allow group members to undo
      const isMember = group.members.some(m => m.toString() === req.user.id);
      if (!isMember) return res.status(403).json({ error: "You are not a member of this group." });

      // Remove/reset submission (customize as per schema)
      if (Array.isArray(group.submissions)) {
        group.submissions = [];
      } else if (group.submission) {
        group.submission = undefined;
      }

      await assignment.save();

      return res.json({ message: "Group submission has been undone." });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to undo group submission." });
    }
  }
);

// GET /submission/:questionId/student/:studentId
Submissionrouter.get("/:questionId/student/:studentId", authmiddleware,authorizedRole("student"), async (req, res) => {
  const { questionId, studentId } = req.params;
  try {
    const submission = await questionSubmissionModel.findOne({
      question: questionId,
      student: studentId,
    });
    res.json({ submission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default Submissionrouter;
