import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import mongoose from "mongoose";
import questionModel from "./question-model.js";
import notificationModel from "../functions/notification-model.js";
import User from "../users/user-model.js";
import CourseInstance from "../course/courseinstance-model.js";
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

      // --- Notification logic here ---
      let recipients = [];
      if (Array.isArray(newQuestion.visibleTo) && newQuestion.visibleTo.length > 0) {
        recipients = newQuestion.visibleTo.map(id => id.toString());
      } else {
        const courseInstance = await CourseInstance.findById(newQuestion.courseInstance);
        if (courseInstance) {
          const batchStudents = await User.find({
            role: "student",
            batch: courseInstance.batch,
          }).select("_id");
          recipients = batchStudents.map(s => s._id.toString());
        }
      }
      if (recipients.length > 0) {
        await notificationModel.create({
          courseInstance: newQuestion.courseInstance,
          type: "question",
          refId: newQuestion._id,
          title: newQuestion.title,
          message: `New question posted: ${newQuestion.title}`,
          createdBy: req.user._id,
          recipients,
        });
      }

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

// // PATCH: Update question (Only by posted teacher)
// QuestionRouter.patch(
//   "/:id",
//   upload.fields([
//     { name: "media", maxCount: 10 },
//     { name: "documents", maxCount: 10 },
//   ]),
//   authmiddleware,
//   authorizedRole("teacher"),
//   async (req, res) => {
//     try {
//       const question = await questionModel.findById(req.params.id);
//       if (!question) return res.status(404).json({ error: "Question not found" });
//       if (!question.postedBy.equals(req.user._id))
//         return res.status(403).json({ error: "You are not allowed to update this question" });

//       if (req.body.dueDate) {
//         const now = new Date();
//         const dueDate = new Date(req.body.dueDate);
//         if (dueDate < now) {
//           return res.status(400).json({ error: "Due date/time cannot be in the past." });
//         }
//         question.dueDate = req.body.dueDate;
//       }
//       if (req.body.title) question.title = req.body.title;
//       if (req.body.content) question.content = req.body.content;
//       if ("topic" in req.body) {
//         if (req.body.topic === "" || req.body.topic === null || req.body.topic === "null") {
//           question.topic = undefined;
//         } else {
//           question.topic = req.body.topic;
//         }
//       }

//       if (req.body.points) question.points = req.body.points;
//       if (req.body.links) question.links = JSON.parse(req.body.links);
//       if (req.body.youtubeLinks) question.youtubeLinks = JSON.parse(req.body.youtubeLinks);

//       // Remove media/docs if specified
//       if (req.body.mediaToRemove) {
//         const toRemove = JSON.parse(req.body.mediaToRemove);
//         question.media = question.media.filter(url => !toRemove.includes(url));
//       }
//       if (req.body.documentsToRemove) {
//         const toRemove = JSON.parse(req.body.documentsToRemove);
//         question.documents = question.documents.filter(url => !toRemove.includes(url));
//       }

//       // Add new files if any
//       if (req.files?.media) {
//         question.media = [...question.media, ...makeFileUrls(req.files.media)];
//       }
//       if (req.files?.documents) {
//         question.documents = [...question.documents, ...makeFileUrls(req.files.documents)];
//       }

//       if (req.body.commentsDisabled !== undefined)
//         question.commentsDisabled = req.body.commentsDisabled === "true";
//       if (req.body.mutedStudents)
//         question.mutedStudents = JSON.parse(req.body.mutedStudents);
//       if (req.body.visibleTo)
//         question.visibleTo = JSON.parse(req.body.visibleTo);

//       await question.save();

//       res.status(201).json({ question: question.toObject() });
//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

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
      // 1. Find the question
      const question = await questionModel.findById(req.params.id);
      if (!question) {
        return res.status(404).json({ error: "Question not found" });
      }

      // 2. Ensure only the posting teacher can update
      if (!question.postedBy.equals(req.user._id)) {
        return res.status(403).json({ error: "You are not allowed to update this question" });
      }

      // 3. Validate and update dueDate if provided
      if (req.body.dueDate) {
        const now = new Date();
        const dueDate = new Date(req.body.dueDate);
        if (dueDate < now) {
          return res.status(400).json({ error: "Due date/time cannot be in the past." });
        }
        question.dueDate = dueDate;
      }

      // 4. Update simple fields
      if (req.body.title)      question.title      = req.body.title;
      if (req.body.content)    question.content    = req.body.content;
       if (req.body.topic === "" || req.body.topic === null || req.body.topic === "null") {
          question.topic = undefined;
        } else {
          question.topic = req.body.topic;
        }
      if (req.body.points)     question.points     = Number(req.body.points);
      if (req.body.links) {
        try {
          question.links = JSON.parse(req.body.links);
        } catch {
          return res.status(400).json({ error: "Invalid links payload" });
        }
      }
      if (req.body.youtubeLinks) {
        try {
          question.youtubeLinks = JSON.parse(req.body.youtubeLinks);
        } catch {
          return res.status(400).json({ error: "Invalid youtubeLinks payload" });
        }
      }
      if (req.body.commentsDisabled !== undefined) {
        question.commentsDisabled = req.body.commentsDisabled === "true";
      }
      if (req.body.mutedStudents) {
        try {
          question.mutedStudents = JSON.parse(req.body.mutedStudents);
        } catch {
          return res.status(400).json({ error: "Invalid mutedStudents payload" });
        }
      }
      if (req.body.visibleTo) {
        try {
          question.visibleTo = JSON.parse(req.body.visibleTo);
        } catch {
          return res.status(400).json({ error: "Invalid visibleTo payload" });
        }
      }

      // 5. Remove existing media items if requested
      if (req.body.mediaToRemove) {
        let toRemove = [];
        try {
          toRemove = JSON.parse(req.body.mediaToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid mediaToRemove payload" });
        }
        question.media = question.media.filter(item => !toRemove.includes(item.url));
      }

      // 6. Remove existing documents if requested
      if (req.body.documentsToRemove) {
        let toRemoveDocs = [];
        try {
          toRemoveDocs = JSON.parse(req.body.documentsToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid documentsToRemove payload" });
        }
        question.documents = question.documents.filter(item => !toRemoveDocs.includes(item.url));
      }

      // 7. Append newly uploaded media
      if (req.files?.media) {
        const newMedia = makeFileUrls(req.files.media);
        question.media = question.media.concat(newMedia);
      }

      // 8. Append newly uploaded documents
      if (req.files?.documents) {
        const newDocs = makeFileUrls(req.files.documents);
        question.documents = question.documents.concat(newDocs);
      }

      // 9. Save and respond
      await question.save();
      res.status(200).json({ question: question.toObject() });
    } catch (err) {
      console.error("Error updating question:", err);
      res.status(500).json({ error: err.message });
    }
  }
);


export default QuestionRouter;
