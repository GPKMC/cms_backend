import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utils/multer-config.js";
import Assignment from "./assignmentModel.js";
import CourseInstance from "../course/courseinstance-model.js";
import Notification from "../functions/notification-model.js"
import User from "../users/user-model.js";
import courseCommentModel from "../comment/courseComment-model.js";
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


// CREATE: POST /assignment with notification
// CREATE: POST /assignment with notification
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

      // Parse potentially stringified arrays safely
      const links         = req.body.links ? JSON.parse(req.body.links) : [];
      const youtubeLinks  = req.body.youtubeLinks ? JSON.parse(req.body.youtubeLinks) : [];
      const mutedStudents = req.body.mutedStudents ? JSON.parse(req.body.mutedStudents) : [];
      const visibleTo     = req.body.visibleTo ? JSON.parse(req.body.visibleTo) : [];

      // ---- Create assignment ----
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
        mutedStudents,
        visibleTo,
        dueDate: req.body.dueDate,
        points: req.body.points,
      });

      // --------------- NOTIFICATION LOGIC -----------------
      try {
        let recipients = [];

        if (Array.isArray(visibleTo) && visibleTo.length > 0) {
          // Only include users who are actually students
          const allowed = await User.find({ _id: { $in: visibleTo }, role: "student" })
            .select("_id")
            .lean();
          recipients = allowed.map(s => s._id);
        } else {
          // All students in the batch of this course instance
          const courseInstance = await CourseInstance.findById(req.body.courseInstance).select("batch").lean();
          if (!courseInstance?.batch) {
            console.warn("⚠️ Notification skipped: courseInstance or batch missing");
          } else {
            const batchStudents = await User.find({
              role: "student",
              batch: courseInstance.batch,
            }).select("_id").lean();
            recipients = batchStudents.map(s => s._id);
          }
        }

        // De-dupe ObjectIds while keeping them as ObjectIds
        if (recipients.length > 1) {
          const map = new Map();
          for (const id of recipients) map.set(String(id), id);
          recipients = [...map.values()];
        }

        // Nothing to notify? Don’t create a useless notification document
        if (!recipients.length) {
          console.warn("⚠️ Notification skipped: no recipients resolved");
        } else {
          await Notification.create({
            courseInstance: req.body.courseInstance,
            type: "assignment",
            refId: newAssignment._id,
            title: newAssignment.title,
            message: `New assignment posted: ${newAssignment.title}`,
            createdBy: req.user._id,   // teacher’s _id
            recipients,                // array of student _ids
          });
          // (Emails will be sent by the Notification model's post-save hook)
        }
      } catch (notifyErr) {
        // Never fail the request because mail/notification failed
        console.error("Notification/email error:", notifyErr);
      }
      // ----------------------------------------------------

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
      const assignment = await Assignment.findById(req.params.id)
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
    const session = await Assignment.startSession();
    try {
      await session.withTransaction(async () => {
        const assignment = await Assignment.findById(req.params.id).session(session);
        if (!assignment) {
          return res.status(404).json({ error: "Assignment not found" });
        }
        if (!assignment.postedBy.equals(req.user._id)) {
          return res
            .status(403)
            .json({ error: "You are not allowed to delete this assignment" });
        }

        // delete comments that belong to this assignment
        await courseCommentModel.deleteMany({
          type: "assignment",
          contentId: assignment._id,
        }).session(session);

        // finally delete the assignment
        await assignment.deleteOne({ session });
      });

      res.json({ message: "Assignment and related comments deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      session.endSession();
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
      if (req.body.topic === "" || req.body.topic === null || req.body.topic === "null") {
          assignment.topic = undefined;
        } else {
          assignment.topic = req.body.topic;
        }
      if (req.body.dueDate) assignment.dueDate = req.body.dueDate;
      if (req.body.points) assignment.points = req.body.points;

      if (req.body.links) assignment.links = JSON.parse(req.body.links);
      if (req.body.youtubeLinks) assignment.youtubeLinks = JSON.parse(req.body.youtubeLinks);

      // Remove media/docs if specified
      if (req.body.mediaToRemove) {
        let toRemove = [];
        try {
          toRemove = JSON.parse(req.body.mediaToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid mediaToRemove payload" });
        }
        assignment.media = assignment.media.filter(item => !toRemove.includes(item.url));
      }
       if (req.body.documentsToRemove) {
        let toRemoveDocs = [];
        try {
          toRemoveDocs = JSON.parse(req.body.documentsToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid documentsToRemove payload" });
        }
        assignment.documents = assignment.documents.filter(item => !toRemoveDocs.includes(item.url));
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
