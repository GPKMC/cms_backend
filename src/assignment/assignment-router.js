import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import Assignment from "./assignmentModel.js";

const AssignmentRouter = express.Router();

// Helper to generate file URLs
function makeFileUrls(files) {
  if (!Array.isArray(files)) return [];
  return files.map(file => {
    let relative = file.path.replace(process.cwd(), "");
    relative = relative.replace(/\\/g, "/").replace(/^\/+/, "/");
    return {
      url: relative,
      originalname: file.originalname,
    };
  });
}


// CREATE: POST /assignment
AssignmentRouter.post(
  "/",
  upload.fields([
    { name: "media", maxCount: 10 },
    { name: "documents", maxCount: 10 },
  ]),
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const mediaFiles = req.files?.media || [];
      const documentFiles = req.files?.documents || [];

      const links = req.body.links ? JSON.parse(req.body.links) : [];
      const youtubeLinks = req.body.youtubeLinks ? JSON.parse(req.body.youtubeLinks) : [];

      const newAssignment = await Assignment.create({
        title: req.body.title,
        content: req.body.content,
        postedBy: req.user._id,
        courseInstance: req.body.courseInstance,
        topic: req.body.topic,
        media: makeFileUrls(mediaFiles),
        documents: makeFileUrls(documentFiles),
        links,
        youtubeLinks,
        commentsDisabled: req.body.commentsDisabled === "true",
        mutedStudents: req.body.mutedStudents ? JSON.parse(req.body.mutedStudents) : [],
        visibleTo: req.body.visibleTo ? JSON.parse(req.body.visibleTo) : [],
        dueDate: req.body.dueDate,
        points: req.body.points,
      });
      res.status(201).json({ assignment: newAssignment });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET ALL assignments for a courseInstance
AssignmentRouter.get(
  "/",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const { courseInstance } = req.query;
      const q = courseInstance ? { courseInstance } : {};

      // Filter for student visibility
      if (req.user.role === "student") {
        q.$or = [
          { visibleTo: { $exists: false } },
          { visibleTo: { $size: 0 } },
          { visibleTo: req.user._id },
        ];
      }

      const assignments = await Assignment.find(q)
        .sort({ dueDate: 1 })
        .populate("postedBy", "username email role")
        .lean();
      res.json({ assignments });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET SINGLE assignment by ID
AssignmentRouter.get(
  "/:id",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const assignment = await assignment_model.findById(req.params.id)
        .populate("postedBy", "username email role")
        .lean();
      if (!assignment) return res.status(404).json({ error: "Not found" });

      if (
        req.user.role === "student" &&
        Array.isArray(assignment.visibleTo) &&
        assignment.visibleTo.length > 0 &&
        !assignment.visibleTo.some(id => id.equals(req.user._id))
      ) {
        return res.status(403).json({ error: "Not allowed to view this assignment" });
      }
      res.json({ assignment });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE: Only poster can delete
AssignmentRouter.delete(
  "/:id",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const assignment = await Assignment.findById(req.params.id);
      if (!assignment) return res.status(404).json({ error: "Assignment not found" });
      // Only posted teacher can delete
      if (!assignment.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to delete this assignment" });

      await assignment.deleteOne();
      res.json({ message: "Assignment deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH: Update assignment (Only by posted teacher)
AssignmentRouter.patch(
  "/:id",
  upload.fields([
    { name: "media", maxCount: 10 },
    { name: "documents", maxCount: 10 },
  ]),
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const assignment = await Assignment.findById(req.params.id);
      if (!assignment) return res.status(404).json({ error: "Assignment not found" });
      // Only posted teacher can update
      if (!assignment.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to update this assignment" });

      if (req.body.title) assignment.title = req.body.title;
      if (req.body.content) assignment.content = req.body.content;
      if (req.body.topic) assignment.topic = req.body.topic;
      if (req.body.dueDate) assignment.dueDate = req.body.dueDate;
      if (req.body.points) assignment.points = req.body.points;

      if (req.body.links) assignment.links = JSON.parse(req.body.links);
      if (req.body.youtubeLinks) assignment.youtubeLinks = JSON.parse(req.body.youtubeLinks);

      // Remove media/docs if specified
      if (req.body.mediaToRemove) {
        const toRemove = JSON.parse(req.body.mediaToRemove);
        assignment.media = assignment.media.filter(url => !toRemove.includes(url));
      }
      if (req.body.documentsToRemove) {
        const toRemove = JSON.parse(req.body.documentsToRemove);
        assignment.documents = assignment.documents.filter(url => !toRemove.includes(url));
      }

      // Add new files if any
      if (req.files?.media) {
        assignment.media = [...assignment.media, ...makeFileUrls(req.files.media)];
      }
      if (req.files?.documents) {
        assignment.documents = [...assignment.documents, ...makeFileUrls(req.files.documents)];
      }

      if (req.body.commentsDisabled !== undefined)
        assignment.commentsDisabled = req.body.commentsDisabled === "true";
      if (req.body.mutedStudents)
        assignment.mutedStudents = JSON.parse(req.body.mutedStudents);
      if (req.body.visibleTo)
        assignment.visibleTo = JSON.parse(req.body.visibleTo);

      await assignment.save();
      res.status(201).json({ assignment: assignment.toObject() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default AssignmentRouter;
