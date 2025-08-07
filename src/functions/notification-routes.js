import express from "express";
import Notification from "./notification-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import assignmentModel from "../assignment/assignmentModel.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";
import courseAnnouncementModel from "../course/courseAnnouncement-model.js";
import questionModel from "../question/question-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import courseCommentModel from "../comment/courseComment-model.js";

const NotificationRouter = express.Router();

// GET: All notifications for a user (filtered by courseInstance)
NotificationRouter.get(
  "/",
  authmiddleware, authorizedRole("student", "teacher"),
  async (req, res) => {
    try {
      const { courseInstance, unread } = req.query;
      const userId = req.user._id;

      // --- 1. Compose query per role ---
      let query = {};
      if (req.user.role === "student") {
        query.recipients = userId;
        if (courseInstance) query.courseInstance = courseInstance;
        if (unread === "true") query.readBy = { $ne: userId };
      } else if (req.user.role === "teacher") {
        // Find all courseInstances where this user is the teacher
        const teacherInstances = await CourseInstance.find({ teacher: userId }).select("_id");
        const courseInstanceIds = teacherInstances.map(ci => ci._id.toString());
        query.courseInstance = { $in: courseInstanceIds };
        if (courseInstance) query.courseInstance = courseInstance;
        if (unread === "true") query.readBy = { $ne: userId };
      } // Add admin logic if needed

      // --- 2. Fetch notifications ---
      let notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(100)
        .populate("createdBy", "username");

      // --- 3. Enhance notifications with comment target info ---
      for (const notif of notifications) {
        if (notif.type === "comment" && notif.refId) {
          // 1. Find the comment document itself
          const comment = await courseCommentModel.findById(notif.refId);
          if (comment) {
            let contentDoc = null;
            let contentModel = null;
            // 2. Choose model based on comment.type
            switch (comment.type) {
              case "assignment":    contentModel = assignmentModel; break;
              case "material":      contentModel = courseMaterialsModel; break;
              case "announcement":  contentModel = courseAnnouncementModel; break;
              case "question":      contentModel = questionModel; break;
              case "quiz":          contentModel = quizquestionModel; break;
            }
            // 3. Lookup target content
            if (contentModel && comment.contentId) {
              contentDoc = await contentModel.findById(comment.contentId).select("title");
            }
            // 4. Attach to notification object
            notif._doc.targetType = comment.type;
            notif._doc.targetTitle = contentDoc?.title || "";
            notif._doc.targetId = comment.contentId?.toString?.() || "";
            notif._doc.commentPreview = comment.content?.slice?.(0, 100) || "";
          }
        }
      }

      return res.json({ notifications });
    } catch (err) {
      console.error("Notification fetch error:", err);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  }
);
// PATCH /notification/:id/mark-read
NotificationRouter.patch(
  "/:id/mark-read",
  authmiddleware,
  async (req, res) => {
    const userId = req.user._id;
    const notifId = req.params.id;
    try {
      const notif = await Notification.findById(notifId);
      if (!notif) return res.status(404).json({ error: "Not found" });
      if (!notif.readBy.includes(userId)) {
        notif.readBy.push(userId);
        await notif.save();
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);
// PATCH /notification/mark-all-read?courseInstance=...
NotificationRouter.patch(
  "/mark-all-read",
  authmiddleware,
  async (req, res) => {
    const userId = req.user._id;
    const { courseInstance } = req.query;
    try {
      const filter = {
        recipients: userId,
        ...(courseInstance ? { courseInstance } : {}),
        readBy: { $ne: userId }
      };
      await Notification.updateMany(filter, { $addToSet: { readBy: userId } });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);
NotificationRouter.patch(
  "/:id/archive",
  authmiddleware,
  async (req, res) => {
    try {
      const notifId = req.params.id;
      const userId = req.user._id;
      const { archive } = req.body; // { archive: true } or { archive: false }

      if (archive) {
        // Add to archivedBy
        await Notification.findByIdAndUpdate(
          notifId,
          { $addToSet: { archivedBy: userId } }
        );
      } else {
        // Remove from archivedBy
        await Notification.findByIdAndUpdate(
          notifId,
          { $pull: { archivedBy: userId } }
        );
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to update archive state" });
    }
  }
);

// PATCH /notification/mark-all-archived?courseInstance=... (archive all)
NotificationRouter.patch(
  "/mark-all-archived",
  authmiddleware,
  async (req, res) => {
    try {
      const userId = req.user._id;
      const { courseInstance } = req.query;

      const filter = {
        recipients: userId,
        ...(courseInstance && { courseInstance }),
        archivedBy: { $ne: userId },
      };

      await Notification.updateMany(
        filter,
        { $addToSet: { archivedBy: userId } }
      );

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to archive all" });
    }
  }
);
export default NotificationRouter;
