import express from "express";

import CourseInstance from "../course/courseinstance-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";

const GroupAssignmentRouter = express.Router();

// Middleware: Only teachers for the courseInstance can manage assignments
const authorizeCourseTeacher = async (req, res, next) => {
  try {
    const courseInstanceId = req.body.courseInstance || req.courseInstanceId;
    if (!courseInstanceId)
      return res.status(400).json({ error: "CourseInstance required." });
    const courseInstance = await CourseInstance.findById(courseInstanceId);
    if (!courseInstance)
      return res.status(404).json({ error: "CourseInstance not found." });
    const teachers = Array.isArray(courseInstance.teacher)
      ? courseInstance.teacher
      : [courseInstance.teacher];
    if (!teachers.some(id => id.equals(req.user._id))) {
      return res.status(403).json({ error: "Not a teacher for this course." });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: "Authorization error." });
  }
};

// 1. Create Group Assignment (teacher only, bulk groups supported)
GroupAssignmentRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  authorizeCourseTeacher,
  async (req, res) => {
    try {
      const assignment = new GroupAssignment({
        ...req.body,
        postedBy: req.user._id
      });
      await assignment.save();
      res.status(201).json({ success: true, data: assignment });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// 2. Get Assignment Details (all roles)
GroupAssignmentRouter.get("/:id", authmiddleware, async (req, res) => {
  try {
    const assignment = await GroupAssignment.findById(req.params.id)
      .populate("postedBy", "username email")
      .populate("courseInstance")
      .populate("topic", "title description")
      .populate("groups.members", "username email")
      .populate("groups.topic", "title")
      .populate("groups.participation.user", "username email");
    if (!assignment)
      return res.status(404).json({ error: "Assignment not found" });
    res.json({ success: true, assignment });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Submit as Group (one member uploads, per-group docs/messages)
GroupAssignmentRouter.post(
  "/:id/group/:groupIdx/submit",
  authmiddleware,
  upload.array("files", 10),
  async (req, res) => {
    try {
      const { id, groupIdx } = req.params;
      const assignment = await GroupAssignment.findById(id);
      if (!assignment)
        return res.status(404).json({ error: "Assignment not found" });
      const group = assignment.groups[groupIdx];
      if (!group)
        return res.status(404).json({ error: "Group not found" });
      if (!group.members.some(m => m.equals(req.user._id))) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      const files =
        req.files?.map(f =>
          "/" + f.path.replace(process.cwd(), "").replace(/\\/g, "/")
        ) || [];
      // Save submission
      const newSubmission = {
        submittedBy: req.user._id,
        files,
        message: req.body.message || ""
      };
      group.submissions.push(newSubmission);

      // Calculate submissionPoints (auto)
      if (assignment.dueDate && group.submissions.length === 1) {
        const submittedAt = new Date();
        const due = new Date(assignment.dueDate);
        const diffMs = submittedAt - due;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        let points = 0;
        if (diffMs <= 0) points = 20;
        else if (diffDays === 1) points = 18;
        else if (diffDays <= 5) points = 15;
        else if (diffDays <= 10) points = 8;
        group.submissionPoints = points;
      }

      await assignment.save();
      res.json({
        success: true,
        submissions: group.submissions,
        submissionPoints: group.submissionPoints
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// 4. Group Discussion Message (auto-increment messageCount)
GroupAssignmentRouter.post(
  "/:id/group/:groupIdx/discuss",
  authmiddleware,
  async (req, res) => {
    try {
      const { id, groupIdx } = req.params;
      const { message } = req.body;
      const userId = req.user._id;
      const assignment = await GroupAssignment.findById(id);
      if (!assignment)
        return res.status(404).json({ error: "Assignment not found" });
      const group = assignment.groups[groupIdx];
      if (!group)
        return res.status(404).json({ error: "Group not found" });
      if (!group.members.some(m => m.equals(userId))) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      group.discussion.push({ user: userId, message });

      // Update messageCount for this user in participation
      let part = group.participation.find(p => p.user.equals(userId));
      if (!part) {
        part = {
          user: userId,
          messageCount: 1,
          discussionMinutes: 0,
          files: [],
          contribution: "",
          discussionPoints: 0
        };
        group.participation.push(part);
      } else {
        part.messageCount = (part.messageCount || 0) + 1;
      }
      await assignment.save();
      res.json({
        success: true,
        discussion: group.discussion,
        participation: group.participation
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// 5. Participation/Logsheet Update (student or teacher)
GroupAssignmentRouter.post(
  "/:id/group/:groupIdx/participation",
  authmiddleware,
  upload.array("files", 5),
  async (req, res) => {
    try {
      const { id, groupIdx } = req.params;
      const { contribution, discussionPoints } = req.body;
      const userId = req.user._id;
      const files =
        req.files?.map(f =>
          "/" + f.path.replace(process.cwd(), "").replace(/\\/g, "/")
        ) || [];
      const assignment = await GroupAssignment.findById(id);
      if (!assignment)
        return res.status(404).json({ error: "Assignment not found" });
      const group = assignment.groups[groupIdx];
      if (!group)
        return res.status(404).json({ error: "Group not found" });
      let part = group.participation.find(p => p.user.equals(userId));
      if (!part) {
        part = {
          user: userId,
          files: [],
          messageCount: 0,
          discussionMinutes: 0,
          contribution: "",
          discussionPoints: 0
        };
        group.participation.push(part);
      }
      part.contribution = contribution ?? part.contribution;
      part.files = part.files ? part.files.concat(files) : files;
      if (typeof discussionPoints !== "undefined") {
        part.discussionPoints = Number(discussionPoints);
      }
      await assignment.save();
      res.json({ success: true, participation: group.participation });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// 6. Teacher sets grading (answerPoints/discussionPoints/feedback/marks)
GroupAssignmentRouter.post(
  "/:id/group/:groupIdx/grade",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res, next) => {
    const assignment = await GroupAssignment.findById(req.params.id);
    if (!assignment)
      return res.status(404).json({ error: "Assignment not found." });
    req.body.courseInstance = assignment.courseInstance;
    next();
  },
  authorizeCourseTeacher,
  async (req, res) => {
    try {
      const { id, groupIdx } = req.params;
      const { answerPoints, discussionPoints, feedback } = req.body;
      const assignment = await GroupAssignment.findById(id);
      const group = assignment.groups[groupIdx];
      if (!group)
        return res.status(404).json({ error: "Group not found" });

      if (typeof answerPoints !== "undefined")
        group.answerPoints = Number(answerPoints);
      if (typeof discussionPoints !== "undefined")
        group.discussionPoints = Number(discussionPoints);
      if (typeof feedback !== "undefined")
        group.feedback = feedback;

      group.marks =
        (group.answerPoints || 0) +
        (group.submissionPoints || 0) +
        (group.discussionPoints || 0);

      await assignment.save();
      res.json({ success: true, marks: group.marks, group });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// 7. (Optional) Teacher can PATCH group details (e.g., per-group title/content/docs)
GroupAssignmentRouter.patch(
  "/:id/group/:groupIdx",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res, next) => {
    const assignment = await GroupAssignment.findById(req.params.id);
    if (!assignment)
      return res.status(404).json({ error: "Assignment not found." });
    req.body.courseInstance = assignment.courseInstance;
    next();
  },
  authorizeCourseTeacher,
  async (req, res) => {
    try {
      const { id, groupIdx } = req.params;
      const { title, content, documents } = req.body;
      const assignment = await GroupAssignment.findById(id);
      const group = assignment.groups[groupIdx];
      if (!group)
        return res.status(404).json({ error: "Group not found" });
      if (title) group.title = title;
      if (content) group.content = content;
      if (documents) group.documents = documents;
      await assignment.save();
      res.json({ success: true, group });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

export default GroupAssignmentRouter;
