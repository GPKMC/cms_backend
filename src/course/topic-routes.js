import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import topicModel from "./topic-model.js";

const TopicRouter = express.Router();

// CREATE - Only teachers
TopicRouter.post(
  "/topic",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { title, description, courseInstance } = req.body;
      if (!title ) return res.status(400).json({ error: "Title required" });
      if (!courseInstance ) return res.status(400).json({ error: "CourseInstance required" });

      const topic = await topicModel.create({
        title,
        description,
        courseInstance,
        createdBy: req.user._id, // Set creator
      });
      res.status(201).json({ topic });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET all topics for a courseInstance (anyone)
TopicRouter.get(
  "/course/:courseInstanceId",
  authmiddleware,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.courseInstanceId))
        return res.status(400).json({ error: "Invalid CourseInstance ID" });
      const topics = await topicModel.find({ courseInstance: req.params.courseInstanceId })
        .sort({ createdAt: 1 })
        .lean();
      res.json({ topics });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// UPDATE topic - Only by creator teacher
TopicRouter.patch(
  "/topic/:id",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const topic = await topicModel.findById(req.params.id);
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      if (!topic.createdBy.equals(req.user._id))
        return res.status(403).json({ error: "Only the teacher who created this topic can edit it" });

      if (req.body.title) topic.title = req.body.title;
      if (req.body.description) topic.description = req.body.description;
      // Optionally: allow courseInstance change?

      await topic.save();
      res.json({ topic });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE topic - Only by creator teacher
TopicRouter.delete(
  "topic/:id",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const topic = await topicModel.findById(req.params.id);
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      if (!topic.createdBy.equals(req.user._id))
        return res.status(403).json({ error: "Only the teacher who created this topic can delete it" });

      await topic.deleteOne();
      res.json({ message: "Topic deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default TopicRouter;
