import express from "express";
import mongoose from "mongoose";
import courseAnnouncement from "./courseAnnouncement.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import multer from "multer";
const upload = multer();
const CourseAnnouncementrouter = express.Router();


// ...your route
CourseAnnouncementrouter.post(
  "/course-announcement",
  upload.any(),  // <-- this parses FormData!
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      // FormData fields are now in req.body, files in req.files
      const {
        content,
        courseInstance,
        commentsDisabled = false,
        mutedStudents = [],
        visibleTo = [],
      } = req.body;

      // attachments can come from req.files:
      const attachments = req.files?.map((file) => file.originalname); // Or handle file saving as needed

      let announcementData = {
        content,
        postedBy: req.user._id,
        courseInstance,
        attachments,
        links: JSON.parse(req.body.links || "[]"),
        commentsDisabled,
        mutedStudents,
      };

      if (req.user.role === "teacher") {
        announcementData.visibleTo = JSON.parse(req.body.visibleTo || "[]");
      } else {
        announcementData.visibleTo = [];
      }

      const announcement = await courseAnnouncement.create(announcementData);

      res.status(201).json({ announcement });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// ✅ Get single announcement by ID
CourseAnnouncementrouter.get("/:id", authmiddleware, async (req, res) => {
  try {
    const announcement = await courseAnnouncement.findById(req.params.id)
      .populate("postedBy", "username email role");

    if (!announcement) return res.status(404).json({ error: "Not found" });

    // 👇 Visibility check for students
    if (req.user.role === "student" &&
        Array.isArray(announcement.visibleTo) &&
        announcement.visibleTo.length > 0 &&
        !announcement.visibleTo.some(id => id.equals(req.user._id))) {
      return res.status(403).json({ error: "Not allowed to view this announcement" });
    }

    res.json({ announcement });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get all announcements for a course instance
CourseAnnouncementrouter.get("/course/:courseInstanceId", authmiddleware, async (req, res) => {
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
          { visibleTo: req.user._id }
        ]
      };
    }

    const announcements = await courseAnnouncement.find(announcementsQuery)
      .sort({ createdAt: -1 })
      .populate("postedBy", "username email");

    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update an announcement
CourseAnnouncementrouter.put(
  "/:id",
  authmiddleware,
  async (req, res) => {
    try {
      const announcement = await courseAnnouncement.findById(req.params.id);
      if (!announcement) return res.status(404).json({ error: "Not found" });

      if (!announcement.postedBy.equals(req.user._id)) {
        return res.status(403).json({ error: "You can only edit your own announcements" });
      }

      // Only allow certain fields to be updated (optionally)
      const updateFields = {
        content: req.body.content,
        attachments: req.body.attachments,
        links: req.body.links,
        commentsDisabled: req.body.commentsDisabled,
        mutedStudents: req.body.mutedStudents,
        visibleTo: req.body.visibleTo, // <<<<< allow update
      };

      const updated = await courseAnnouncement.findByIdAndUpdate(
        req.params.id,
        updateFields,
        { new: true }
      );

      res.json({ announcement: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ✅ Delete an announcement
CourseAnnouncementrouter.delete(
  "/:id",
  authmiddleware,
  async (req, res) => {
    try {
      const announcement = await courseAnnouncement.findById(req.params.id);
      if (!announcement) return res.status(404).json({ error: "Not found" });

      if (!announcement.postedBy.equals(req.user._id)) {
        return res.status(403).json({ error: "You can only delete your own announcements" });
      }

      await courseAnnouncement.findByIdAndDelete(req.params.id);
      res.json({ message: "Deleted successfully" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default CourseAnnouncementrouter;
