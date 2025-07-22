import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import CourseMaterial from "./courseMaterials-model.js";

const CourseMaterialRouter = express.Router();

// Helper to generate file URLs
function makeFileUrls(files) {
  if (!Array.isArray(files)) return [];
  return files.map(file =>
    "/" + file.path.replace(process.cwd(), "").replace(/\\/g, "/")
  );
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
        title: req.body.title,    // Title field added here!
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
      res.status(201).json({ material: newMaterial });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET ALL materials for a courseInstance


// GET SINGLE material by ID
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
      if (req.body.topic) material.topic = req.body.topic;

      if (req.body.links) material.links = JSON.parse(req.body.links);
      if (req.body.youtubeLinks) material.youtubeLinks = JSON.parse(req.body.youtubeLinks);

      // Remove media/docs if specified
      if (req.body.mediaToRemove) {
        const toRemove = JSON.parse(req.body.mediaToRemove);
        material.media = material.media.filter(url => !toRemove.includes(url));
      }
      if (req.body.documentsToRemove) {
        const toRemove = JSON.parse(req.body.documentsToRemove);
        material.documents = material.documents.filter(url => !toRemove.includes(url));
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
