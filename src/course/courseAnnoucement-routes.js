import express from "express";
import mongoose from "mongoose";
import CourseAnnouncement from "./courseAnnouncement-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import CourseInstance from "./courseinstance-model.js";
import User from "../users/user-model.js";
import notificationModel from "../functions/notification-model.js";

const CourseAnnouncementrouter = express.Router();

// Helper: categorize attachments
function categorizeAttachments(files) {
  const images = [];
  const documents = [];
  files.forEach((file) => {
    const relPath = file.path.replace(process.cwd(), "").replace(/\\/g, "/");
    if (file.mimetype.startsWith("image/")) {
      images.push(relPath.startsWith("/") ? relPath : "/" + relPath);
    } else {
      documents.push(relPath.startsWith("/") ? relPath : "/" + relPath);
    }
  });
  return { images, documents };
}

// Helper: categorize YouTube and other links
function categorizeLinks(allLinks) {
  const youtubeLinks = [];
  const links = [];
  allLinks.forEach((url) => {
    if (typeof url === "string" && url.match(/(youtube\.com|youtu\.be)/i)) {
      youtubeLinks.push(url);
    } else {
      links.push(url);
    }
  });
  return { youtubeLinks, links };
}


CourseAnnouncementrouter.post(
  "/course-announcement",
  upload.any(),
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const { images, documents } = categorizeAttachments(req.files || []);
      const linksArr = JSON.parse(req.body.links || "[]");
      const youtubeArr = JSON.parse(req.body.videos || "[]");
      const allLinks = linksArr.concat(youtubeArr);
      const { youtubeLinks, links } = categorizeLinks(allLinks);

      const announcementData = {
        content: req.body.content,
        postedBy: req.user._id,
        courseInstance: req.body.courseInstance,
        images,
        documents,
        links,
        youtubeLinks,
        commentsDisabled: req.body.commentsDisabled === "true",
        mutedStudents: JSON.parse(req.body.mutedStudents || "[]"),
        visibleTo: req.user.role === "teacher"
          ? JSON.parse(req.body.visibleTo || "[]")
          : [],
      };

      const announcement = await CourseAnnouncement.create(announcementData);

      // --------- NOTIFICATION LOGIC STARTS HERE ---------
      let recipients = [];
      if (announcement.visibleTo && announcement.visibleTo.length > 0) {
        recipients = announcement.visibleTo.map(id => id.toString());
      } else {
        // Get all students from the batch via courseInstance if visibleTo not specified
        const courseInstance = await CourseInstance.findById(announcement.courseInstance);
        if (courseInstance) {
          const batchStudents = await User.find({
            role: "student",
            batch: courseInstance.batch,
          }).select("_id");
          recipients = batchStudents.map(s => s._id.toString());
        }
      }

      // Only create notification if there's someone to notify
      if (recipients.length > 0) {
        await notificationModel.create({
          courseInstance: announcement.courseInstance,
          type: "announcement",
          refId: announcement._id,
          title: "New Course Announcement",
          message: "A new announcement has been posted.",
          createdBy: req.user._id,
          recipients,
        });
      }
      // --------- NOTIFICATION LOGIC ENDS HERE ---------

      res.status(201).json({ announcement });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// GET: All announcements for a course instance (categorized)
CourseAnnouncementrouter.get(
  "/course/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.courseInstanceId)) {
        return res.status(400).json({ error: "Invalid CourseInstance ID" });
      }

      let announcementsQuery = { courseInstance: req.params.courseInstanceId };
      // Students only see announcements visible to them, or public ones
      if (req.user.role === "student") {
        announcementsQuery = {
          ...announcementsQuery,
          $or: [
            { visibleTo: { $exists: false } },
            { visibleTo: { $size: 0 } },
            { visibleTo: req.user._id },
          ],
        };
      }

      const announcements = await CourseAnnouncement.find(announcementsQuery)
        .sort({ createdAt: -1 })
        .populate("postedBy", "username email");

      res.json({ announcements });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET: Single announcement by ID
CourseAnnouncementrouter.get("/:id",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const announcement = await CourseAnnouncement.findById(req.params.id)
        .populate("postedBy", "username email role");

      if (!announcement) return res.status(404).json({ error: "Not found" });

      // Visibility check for students
      if (
        req.user.role === "student" &&
        Array.isArray(announcement.visibleTo) &&
        announcement.visibleTo.length > 0 &&
        !announcement.visibleTo.some(id => id.equals(req.user._id))
      ) {
        return res.status(403).json({ error: "Not allowed to view this announcement" });
      }

      res.json({ announcement });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
CourseAnnouncementrouter.delete(
  "/:id",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const announcement = await CourseAnnouncement.findById(req.params.id);
      if (!announcement)
        return res.status(404).json({ error: "Announcement not found" });

      // Only poster can delete
      if (!announcement.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to delete this announcement" });

      await announcement.deleteOne();
      res.json({ message: "Announcement deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
CourseAnnouncementrouter.patch(
  "/:id",
  upload.any(),
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const announcement = await CourseAnnouncement.findById(req.params.id);
      if (!announcement)
        return res.status(404).json({ error: "Announcement not found" });

      // Only poster can update
      if (!announcement.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to update this announcement" });

      // --- Update fields ---
      if (req.body.content) announcement.content = req.body.content;

      // LINKS/YOUTUBE: Replace only if sent; otherwise keep unchanged
      if (req.body.links) announcement.links = JSON.parse(req.body.links);
      if (req.body.videos) announcement.youtubeLinks = JSON.parse(req.body.videos);

      // IMAGES/DOCS: Merge new, remove as requested
      // Remove images
      if (req.body.imagesToRemove) {
        const toRemove = JSON.parse(req.body.imagesToRemove);
        announcement.images = announcement.images.filter(img => !toRemove.includes(img));
      }
      // Remove docs
      if (req.body.docsToRemove) {
        const toRemove = JSON.parse(req.body.docsToRemove);
        announcement.documents = announcement.documents.filter(doc => !toRemove.includes(doc));
      }
      // Add new files (if any)
      if (req.files && req.files.length > 0) {
        const { images, documents } = categorizeAttachments(req.files);
        // Merge, avoid duplicate filenames/IDs (if necessary)
        announcement.images = [...announcement.images, ...images];
        announcement.documents = [...announcement.documents, ...documents];
      }

      if (req.body.commentsDisabled !== undefined) {
        announcement.commentsDisabled = req.body.commentsDisabled === "true";
      }
      if (req.body.mutedStudents) {
        announcement.mutedStudents = JSON.parse(req.body.mutedStudents);
      }
      if (req.body.visibleTo) {
        announcement.visibleTo = JSON.parse(req.body.visibleTo);
      }

      await announcement.save();
      res.json({ announcement });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


export default CourseAnnouncementrouter;
