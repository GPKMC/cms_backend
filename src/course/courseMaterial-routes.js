import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utils/multer-config.js";
import CourseMaterial from "./courseMaterials-model.js";
import CourseInstance from "./courseinstance-model.js";
import notificationModel from "../functions/notification-model.js";
import User from "../users/user-model.js";

const CourseMaterialRouter = express.Router();

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


// CREATE: POST /course-material
CourseMaterialRouter.post(
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

      const newMaterial = await CourseMaterial.create({
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
      });

      // --- Notification logic here ---

      // 1. Find recipients (visibleTo has priority, else all students in batch)
      let recipients = [];
      if (Array.isArray(newMaterial.visibleTo) && newMaterial.visibleTo.length > 0) {
        recipients = newMaterial.visibleTo.map(id => id.toString());
      } else {
        // Find the courseInstance, then its batch, then all students in that batch
        const courseInstance = await CourseInstance.findById(newMaterial.courseInstance);
        if (courseInstance) {
          const batchStudents = await User.find({
            role: "student",
            batch: courseInstance.batch,
          }).select("_id");
          recipients = batchStudents.map(s => s._id.toString());
        }
      }

      // 2. Create notification
      if (recipients.length > 0) {
        await notificationModel.create({
          courseInstance: newMaterial.courseInstance,
          type: "material",
          refId: newMaterial._id,
          title: newMaterial.title,
          message: `New material posted: ${newMaterial.title}`,
          createdBy: req.user._id,
          recipients,
        });
      }

      res.status(201).json({ material: newMaterial });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
// routes/courseMaterials.js

CourseMaterialRouter.get("/material/:id",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const material = await CourseMaterial.findById(req.params.id)
        .populate("postedBy", "username email role")
        .lean();
      if (!material) return res.status(404).json({ error: "Not found" });

      if (
        req.user.role === "student" &&
        Array.isArray(material.visibleTo) &&
        material.visibleTo.length > 0 &&
        !material.visibleTo.some(id => id.equals(req.user._id))
      ) {
        return res.status(403).json({ error: "Not allowed to view this material" });
      }
      res.json({ material });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

CourseMaterialRouter.get("/course/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.courseInstanceId))
        return res.status(400).json({ error: "Invalid CourseInstance ID" });
      let q = { courseInstance: req.params.courseInstanceId };
      if (req.user.role === "student") {
        q = {
          ...q,
          $or: [
            { visibleTo: { $exists: false } },
            { visibleTo: { $size: 0 } },
            { visibleTo: req.user._id },
          ]
        };
      }
      const materials = await CourseMaterial.find(q)
        .sort({ createdAt: -1 })
        .populate("postedBy", "username email")
        .lean();
      res.json({ materials });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);



// DELETE: Only poster can delete
CourseMaterialRouter.delete("/:id",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const material = await CourseMaterial.findById(req.params.id);
      if (!material) return res.status(404).json({ error: "Material not found" });
      // Only posted teacher can delete
      if (!material.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to delete this material" });

      await material.deleteOne();
      res.json({ message: "Material deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH: Update material (Only by posted teacher)
CourseMaterialRouter.patch("/:id",
  upload.fields([
    { name: "media", maxCount: 10 },
    { name: "documents", maxCount: 10 },
  ]),
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const material = await CourseMaterial.findById(req.params.id);
      if (!material) return res.status(404).json({ error: "Material not found" });
      // Only posted teacher can update
      if (!material.postedBy.equals(req.user._id))
        return res.status(403).json({ error: "You are not allowed to update this material" });

      if (req.body.title) material.title = req.body.title;
      if (req.body.content) material.content = req.body.content;
     if (req.body.topic === "" || req.body.topic === null || req.body.topic === "null") {
          material.topic = undefined;
        } else {
          material.topic = req.body.topic;
        }
      if (req.body.links) material.links = JSON.parse(req.body.links);
      if (req.body.youtubeLinks) material.youtubeLinks = JSON.parse(req.body.youtubeLinks);

       if (req.body.mediaToRemove) {
        let toRemove = [];
        try {
          toRemove = JSON.parse(req.body.mediaToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid mediaToRemove payload" });
        }
        material.media = material.media.filter(item => !toRemove.includes(item.url));
      }

      // 6. Remove existing documents if requested
      if (req.body.documentsToRemove) {
        let toRemoveDocs = [];
        try {
          toRemoveDocs = JSON.parse(req.body.documentsToRemove);
        } catch {
          return res.status(400).json({ error: "Invalid documentsToRemove payload" });
        }
        material.documents = material.documents.filter(item => !toRemoveDocs.includes(item.url));
      }

      // Add new files if any
      if (req.files?.media) {
        material.media = [...material.media, ...makeFileUrls(req.files.media)];
      }
      if (req.files?.documents) {
        material.documents = [...material.documents, ...makeFileUrls(req.files.documents)];
      }

      if (req.body.commentsDisabled !== undefined)
        material.commentsDisabled = req.body.commentsDisabled === "true";
      if (req.body.mutedStudents)
        material.mutedStudents = JSON.parse(req.body.mutedStudents);
      if (req.body.visibleTo)
        material.visibleTo = JSON.parse(req.body.visibleTo);

      await material.save();
      res.status(201).json({ material: material.toObject() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default CourseMaterialRouter;
