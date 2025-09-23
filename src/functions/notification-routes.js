// notification routes for fetching  notifications related to assignments,announcements and many more
import express from "express";
import Notification from "./notification-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

// Content models
import assignmentModel from "../assignment/assignmentModel.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";
import courseAnnouncementModel from "../course/courseAnnouncement-model.js";
import questionModel from "../question/question-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import courseCommentModel from "../comment/courseComment-model.js";

import groupAssignmentModel from "../assignment/groupAssignment-model.js";
// NOTE: ensure this import path matches your schema filename
import groupSubmissionModel from "../assignment/groupSubmission-model.js"; 
import questionSubmissionModel from "../question/questionSubmission-model.js";
import AssignmentSubmissionModel from "../assignment/AssignmentSubmission-model.js";

const NotificationRouter = express.Router();

/**
 * GET /notification
 * - Students: notifications where recipients include user
 * - Teachers: notifications for their courseInstances; includes legacy rows missing courseInstance,
 *   then enriched & filtered in-memory if courseInstance is provided.
 */
NotificationRouter.get(
  "/",
  authmiddleware,
  authorizedRole("student", "teacher"),
  async (req, res) => {
    try {
      const { courseInstance, unread } = req.query;
      const userId = req.user._id;

      let query = {};

      if (req.user.role === "student") {
        query = {
          recipients: userId,
          ...(courseInstance ? { courseInstance } : {}),
          ...(unread === "true" ? { readBy: { $ne: userId } } : {}),
        };
      } else if (req.user.role === "teacher") {
        const teacherInstances = await CourseInstance.find({ teacher: userId })
          .select("_id")
          .lean();
        const ciIds = teacherInstances.map((ci) => ci._id.toString());

        // Include docs that might be missing courseInstance (legacy)
        if (courseInstance) {
          query = {
            $or: [
              { courseInstance: courseInstance },
              { courseInstance: { $exists: false } },
            ],
            ...(unread === "true" ? { readBy: { $ne: userId } } : {}),
          };
        } else {
          query = {
            $or: [
              { courseInstance: { $in: ciIds } },
              { courseInstance: { $exists: false } },
            ],
            ...(unread === "true" ? { readBy: { $ne: userId } } : {}),
          };
        }
      }

      // Fetch base notifications
      let notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(300) // fetch more; we will filter/slice after enrichment
        .populate("createdBy", "username email")
        .lean();

      // Enrichment
      notifications = await Promise.all(
        notifications.map(async (notif) => {
          try {
            // ---- Base Content Items by notif.type ----
            if (notif.refId) {
              if (notif.type === "assignment") {
                const doc = await assignmentModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "assignment";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }

              if (notif.type === "group-assignment") {
                const doc = await groupAssignmentModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "group-assignment";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }

              if (notif.type === "material") {
                const doc = await courseMaterialsModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "material";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }

              if (notif.type === "announcement") {
                const doc = await courseAnnouncementModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "announcement";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }

              if (notif.type === "question") {
                const doc = await questionModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "question";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }

              if (notif.type === "quiz") {
                const doc = await quizquestionModel
                  .findById(notif.refId)
                  .select("title courseInstance")
                  .lean();
                if (doc) {
                  notif.targetType = "quiz";
                  notif.targetTitle = doc.title || "";
                  notif.targetId = doc._id.toString();
                  if (!notif.courseInstance && doc.courseInstance) {
                    notif.courseInstance = doc.courseInstance.toString();
                  }
                }
              }
            }

            // ---- Comments ----
            if (notif.type === "comment" && notif.refId) {
              const comment = await courseCommentModel.findById(notif.refId).lean();
              if (comment) {
                let contentModel = null;
                switch (comment.type) {
                  case "assignment":
                    contentModel = assignmentModel;
                    break;
                  case "material":
                    contentModel = courseMaterialsModel;
                    break;
                  case "announcement":
                    contentModel = courseAnnouncementModel;
                    break;
                  case "question":
                    contentModel = questionModel;
                    break;
                  case "quiz":
                    contentModel = quizquestionModel;
                    break;
                  case "group-assignment":
                    contentModel = groupAssignmentModel;
                    break;
                }
                let contentDoc = null;
                if (contentModel && comment.contentId) {
                  contentDoc = await contentModel
                    .findById(comment.contentId)
                    .select("title courseInstance")
                    .lean();
                }
                notif.targetType = comment.type;
                notif.targetTitle = contentDoc?.title || "";
                notif.targetId = comment.contentId?.toString?.() || "";
                notif.commentPreview = comment.content?.slice?.(0, 100) || "";
                if (!notif.courseInstance && contentDoc?.courseInstance) {
                  notif.courseInstance = contentDoc.courseInstance.toString();
                }
              }
            }

            // ---- Assignment Submission ----
            if (notif.type === "assignment-submission" && notif.refId) {
              const sub = await AssignmentSubmissionModel.findById(notif.refId)
                .select("assignment student files submittedAt")
                .populate("student", "username email")
                .populate("assignment", "title courseInstance")
                .lean();
              if (sub) {
                notif.targetType = "assignment";
                notif.targetTitle = sub.assignment?.title || "";
                notif.targetId = sub.assignment?._id?.toString?.() || "";
                notif.submittedBy = sub.student
                  ? { _id: sub.student._id, username: sub.student.username || sub.student.email }
                  : null;
                notif.fileCount = Array.isArray(sub.files) ? sub.files.length : 0;
                notif.submittedAt = sub.submittedAt;
                if (!notif.courseInstance && sub.assignment?.courseInstance) {
                  notif.courseInstance = sub.assignment.courseInstance.toString();
                }
              }
            }

            // ---- Group Assignment Submission ----
            if (notif.type === "group-assignment-submission" && notif.refId) {
              const gsub = await groupSubmissionModel
                .findById(notif.refId)
                .select("groupAssignmentId groupId submittedBy files submittedAt")
                .populate("submittedBy", "username email")
                .populate("groupAssignmentId", "title groups courseInstance")
                .lean();

              if (gsub) {
                let grp = null;
                if (gsub.groupAssignmentId && Array.isArray(gsub.groupAssignmentId.groups)) {
                  grp = gsub.groupAssignmentId.groups.find(
                    (g) =>
                      g &&
                      g._id &&
                      gsub.groupId &&
                      g._id.toString() === gsub.groupId.toString()
                  );
                }

                notif.targetType = "group-assignment";
                notif.targetTitle = gsub.groupAssignmentId?.title || "";
                notif.targetId = gsub.groupAssignmentId?._id?.toString?.() || "";
                notif.group = grp
                  ? { _id: grp._id, name: grp.name || "" }
                  : gsub.groupId
                  ? { _id: gsub.groupId, name: "" }
                  : null;

                notif.submittedBy = gsub.submittedBy
                  ? { _id: gsub.submittedBy._id, username: gsub.submittedBy.username || gsub.submittedBy.email }
                  : null;

                notif.fileCount = Array.isArray(gsub.files) ? gsub.files.length : 0;
                notif.submittedAt = gsub.submittedAt;

                if (!notif.courseInstance && gsub.groupAssignmentId?.courseInstance) {
                  notif.courseInstance = gsub.groupAssignmentId.courseInstance.toString();
                }
              }
            }

            // ---- Question Submission ----
            if (notif.type === "question-submission" && notif.refId) {
              const qsub = await questionSubmissionModel
                .findById(notif.refId)
                .select("question student submittedAt")
                .populate("student", "username email")
                .populate("question", "title courseInstance")
                .lean();

              if (qsub) {
                notif.targetType = "question";
                notif.targetTitle = qsub.question?.title || "";
                notif.targetId = qsub.question?._id?.toString?.() || "";
                notif.submittedBy = qsub.student
                  ? { _id: qsub.student._id, username: qsub.student.username || qsub.student.email }
                  : null;
                notif.submittedAt = qsub.submittedAt;
                if (!notif.courseInstance && qsub.question?.courseInstance) {
                  notif.courseInstance = qsub.question.courseInstance.toString();
                }
              }
            }

            return notif;
          } catch (e) {
            console.error("Notif enrichment error:", e);
            return notif;
          }
        })
      );

      // Teacher requested a specific CI? Now we can filter (after enrichment)
      if (courseInstance) {
        notifications = notifications.filter(
          (n) => String(n.courseInstance) === String(courseInstance)
        );
      }

      // Final sort & limit
      notifications.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      notifications = notifications.slice(0, 100);

      res.json({ notifications });
    } catch (err) {
      console.error("Notification fetch error:", err);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  }
);

// PATCH /notification/:id/mark-read
NotificationRouter.patch("/:id/mark-read", authmiddleware, async (req, res) => {
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
});

// PATCH /notification/mark-all-read
// Role-aware: works for students and teachers
NotificationRouter.patch("/mark-all-read", authmiddleware, async (req, res) => {
  const userId = req.user._id;
  const { courseInstance } = req.query || {};
  try {
    if (req.user.role === "teacher") {
      let ciFilter = {};
      if (courseInstance) {
        ciFilter = { $or: [{ courseInstance }, { courseInstance: { $exists: false } }] };
      } else {
        const teacherInstances = await CourseInstance.find({ teacher: userId }).select("_id").lean();
        const ids = teacherInstances.map(ci => ci._id);
        ciFilter = { $or: [{ courseInstance: { $in: ids } }, { courseInstance: { $exists: false } }] };
      }
      await Notification.updateMany(
        { ...ciFilter, readBy: { $ne: userId } },
        { $addToSet: { readBy: userId } }
      );
      return res.json({ success: true });
    }

    // student branch
    const filter = {
      recipients: userId,
      ...(courseInstance ? { courseInstance } : {}),
      readBy: { $ne: userId },
    };
    await Notification.updateMany(filter, { $addToSet: { readBy: userId } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /notification/:id/archive
NotificationRouter.patch("/:id/archive", authmiddleware, async (req, res) => {
  try {
    const notifId = req.params.id;
    const userId = req.user._id;
    const { archive } = req.body;
    if (archive) {
      await Notification.findByIdAndUpdate(notifId, { $addToSet: { archivedBy: userId } });
    } else {
      await Notification.findByIdAndUpdate(notifId, { $pull: { archivedBy: userId } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Archive error:", err);
    res.status(500).json({ error: "Failed to update archive state" });
  }
});

// PATCH /notification/mark-all-archived
// Role-aware: works for students and teachers
NotificationRouter.patch("/mark-all-archived", authmiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const { courseInstance } = req.query || {};

    if (req.user.role === "teacher") {
      let ciFilter = {};
      if (courseInstance) {
        ciFilter = { $or: [{ courseInstance }, { courseInstance: { $exists: false } }] };
      } else {
        const teacherInstances = await CourseInstance.find({ teacher: userId }).select("_id").lean();
        const ids = teacherInstances.map(ci => ci._id);
        ciFilter = { $or: [{ courseInstance: { $in: ids } }, { courseInstance: { $exists: false } }] };
      }
      await Notification.updateMany(
        { ...ciFilter, archivedBy: { $ne: userId } },
        { $addToSet: { archivedBy: userId } }
      );
      return res.json({ success: true });
    }

    // student branch
    const filter = {
      recipients: userId,
      ...(courseInstance ? { courseInstance } : {}),
      archivedBy: { $ne: userId },
    };
    await Notification.updateMany(filter, { $addToSet: { archivedBy: userId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to archive all" });
  }
});

export default NotificationRouter;
