import express from "express";
import mongoose from "mongoose";
import courseAnnouncement from "./courseAnnouncement.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

const CourseAnnouncementrouter=express.Router();

// ✅ Create new announcement
CourseAnnouncementrouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const {
        content,
        courseInstance,
        attachments = [],
        links = [],
        commentsDisabled = false,
        mutedStudents = [],
      } = req.body;

      const announcement = await courseAnnouncement.create({
        content,
        postedBy: req.user._id,
        courseInstance,
        attachments,
        links,
        commentsDisabled,
        mutedStudents,
      });

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

    const announcements = await courseAnnouncement.find({
      courseInstance: req.params.courseInstanceId,
    })
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

      const updated = await courseAnnouncement.findByIdAndUpdate(
        req.params.id,
        req.body,
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
