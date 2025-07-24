import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import mongoose from "mongoose";
import questionModel from "./question-model.js";
const QuestionRouter = express.Router();

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


// CREATE: POST /question
QuestionRouter.post(
  "/",
  upload.fields([
    { name: "media", maxCount: 10 },
    { name: "documents", maxCount: 10 },
  ]),
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      if (req.body.dueDate) {
        const now = new Date();
        const dueDate = new Date(req.body.dueDate);
        if (dueDate < now) {
          return res.status(400).json({ error: "Due date/time cannot be in the past." });
        }
      }
      const mediaFiles = req.files?.media || [];
      const documentFiles = req.files?.documents || [];

      const links = req.body.links ? JSON.parse(req.body.links) : [];
      const youtubeLinks = req.body.youtubeLinks ? JSON.parse(req.body.youtubeLinks) : [];

      const newQuestion = await questionModel.create({
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
      res.status(201).json({ question: newQuestion });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET ALL questions for a courseInstance
QuestionRouter.get(
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

      const questions = await questionModel.find(q)
        .sort({ dueDate: 1 })
        .populate("postedBy", "username email role")
        .lean();
      res.json({ questions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET SINGLE question by ID 
QuestionRouter.get(
  "/:id",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid question id" });
      }

      const question = await questionModel.findById(req.params.id)
        .populate("postedBy", "username email role")
        .lean();

      if (!question) return res.status(404).json({ error: "Not found" });

      if (
        req.user.role === "student" &&
        Array.isArray(question.visibleTo) &&
        question.visibleTo.length > 0 &&
        !question.visibleTo.some(id => id.equals(req.user._id))
      ) {
        return res.status(403).json({ error: "Not allowed to view this question" });
      }
      res.json({ question });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE: Only poster can delete
QuestionRouter.delete(
  "/:id",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const question = await questionModel.findById(req.params.id);
      if (!question) return res.status(404).json({ error: "Question not found" });
      if (!question.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to delete this question" });

      await question.deleteOne();
      res.json({ message: "Question deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH: Update question (Only by posted teacher)
QuestionRouter.patch(
  "/:id",
  upload.fields([
    { name: "media", maxCount: 10 },
    { name: "documents", maxCount: 10 },
  ]),
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const question = await questionModel.findById(req.params.id);
      if (!question) return res.status(404).json({ error: "Question not found" });
      if (!question.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to update this question" });

      if (req.body.dueDate) {
        const now = new Date();
        const dueDate = new Date(req.body.dueDate);
        if (dueDate < now) {
          return res.status(400).json({ error: "Due date/time cannot be in the past." });
        }
        question.dueDate = req.body.dueDate;
      }
      if (req.body.title) question.title = req.body.title;
      if (req.body.content) question.content = req.body.content;
      if ("topic" in req.body) {
        if (req.body.topic === "" || req.body.topic === null || req.body.topic === "null") {
          question.topic = undefined;
        } else {
          question.topic = req.body.topic;
        }
      }

      if (req.body.points) question.points = req.body.points;
      if (req.body.links) question.links = JSON.parse(req.body.links);
      if (req.body.youtubeLinks) question.youtubeLinks = JSON.parse(req.body.youtubeLinks);

      // Remove media/docs if specified
      if (req.body.mediaToRemove) {
        const toRemove = JSON.parse(req.body.mediaToRemove);
        question.media = question.media.filter(url => !toRemove.includes(url));
      }
      if (req.body.documentsToRemove) {
        const toRemove = JSON.parse(req.body.documentsToRemove);
        question.documents = question.documents.filter(url => !toRemove.includes(url));
      }

      // Add new files if any
      if (req.files?.media) {
        question.media = [...question.media, ...makeFileUrls(req.files.media)];
      }
      if (req.files?.documents) {
        question.documents = [...question.documents, ...makeFileUrls(req.files.documents)];
      }

      if (req.body.commentsDisabled !== undefined)
        question.commentsDisabled = req.body.commentsDisabled === "true";
      if (req.body.mutedStudents)
        question.mutedStudents = JSON.parse(req.body.mutedStudents);
      if (req.body.visibleTo)
        question.visibleTo = JSON.parse(req.body.visibleTo);

      await question.save();

      res.status(201).json({ question: question.toObject() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default QuestionRouter;
