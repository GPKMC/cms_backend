import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";
import courseMaterialsModel from "./courseMaterials-model.js";

const CourseMaterialRouter = express.Router();

// Helper: Convert uploaded files to fileSchema format
function toFileObjects(files) {
    return (files || []).map((file) => ({
        filename: file.originalname,
        url: "/" + file.path.replace(process.cwd(), "").replace(/\\/g, "/"),
        mimetype: file.mimetype,
        size: file.size,
        uploadedAt: new Date()
    }));
}

// Helper: Convert links to schema format, identify YouTube
function toLinkObjects(allLinks) {
    if (!Array.isArray(allLinks)) return [];
    return allLinks.map((url) => ({
        url,
        title: "", // Optional, can extract from frontend
        type: /youtube\.com|youtu\.be/i.test(url) ? "youtube" : "resource"
    }));
}

// POST: Create new course material
CourseMaterialRouter.post(
    "/course-material",
    upload.any(),
    authmiddleware,
    authorizedRole("teacher"),
    async (req, res) => {
        try {
            // Files
            const files = toFileObjects(req.files);
            // Links
            const linksArr = JSON.parse(req.body.links || "[]"); // Expect links as JSON string array
            const links = toLinkObjects(linksArr);

            const courseMaterialData = {
                content: req.body.content,
                postedBy: req.user._id,
                courseInstance: req.body.courseInstance,
                files,
                links,
                images: JSON.parse(req.body.images || "[]"), // Optional (urls)
                commentsDisabled: req.body.commentsDisabled === "true",
                mutedStudents: JSON.parse(req.body.mutedStudents || "[]"),
                visibleTo: req.user.role === "teacher"
                    ? JSON.parse(req.body.visibleTo || "[]")
                    : [],
            };

            const material = await courseMaterialsModel.create(courseMaterialData);
            res.status(201).json({ material: material.toObject() }); // after create()
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// GET: All materials for a course instance
CourseMaterialRouter.get(
    "/course/:courseInstanceId",
    authmiddleware,
    authorizedRole("teacher", "student"),
    async (req, res) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.courseInstanceId)) {
                return res.status(400).json({ error: "Invalid CourseInstance ID" });
            }

            let materialQuery = { courseInstance: req.params.courseInstanceId };
            if (req.user.role === "student") {
                materialQuery = {
                    ...materialQuery,
                    $or: [
                        { visibleTo: { $exists: false } },
                        { visibleTo: { $size: 0 } },
                        { visibleTo: req.user._id },
                    ],
                };
            }

            const materials = await CourseMaterial.find(materialQuery)
                .sort({ createdAt: -1 })
                .populate("postedBy", "username email")
                .lean(); // <--- THIS IS THE FIX
            res.json({ materials });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// GET: Single material by ID
CourseMaterialRouter.get("/:id",
    authmiddleware,
    authorizedRole("teacher", "student"),
    async (req, res) => {
        try {
            const material = await CourseMaterial.findById(req.params.id)
                .populate("postedBy", "username email role")
                .lean(); // <--- THIS IS THE FIX
            if (!material) return res.status(404).json({ error: "Not found" });
            res.json({ material });


            // Visibility check for students
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
CourseMaterialRouter.delete(
    "/:id",
    authmiddleware,
    authorizedRole("teacher"),
    async (req, res) => {
        try {
            const material = await CourseMaterial.findById(req.params.id);
            if (!material) return res.status(404).json({ error: "Material not found" });
            if (!material.postedBy.equals(req.user._id))
                return res.status(403).json({ error: "You are not allowed to delete this material" });

            await material.deleteOne();
            res.json({ message: "Material deleted" });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// PATCH: Update material (add/remove files, update links/content/visibility)
CourseMaterialRouter.patch(
    "/:id",
    upload.any(),
    authmiddleware,
    authorizedRole("teacher"),
    async (req, res) => {
        try {
            const material = await CourseMaterial.findById(req.params.id);
            if (!material) return res.status(404).json({ error: "Material not found" });
            if (!material.postedBy.equals(req.user._id))
                return res.status(403).json({ error: "You are not allowed to update this material" });

            if (req.body.content) material.content = req.body.content;

            // Links: Replace if sent
            if (req.body.links) material.links = toLinkObjects(JSON.parse(req.body.links));

            // Files: Remove files
            if (req.body.filesToRemove) {
                const toRemove = JSON.parse(req.body.filesToRemove);
                material.files = material.files.filter(f => !toRemove.includes(f.url));
            }
            // Add new files (if any)
            if (req.files && req.files.length > 0) {
                const newFiles = toFileObjects(req.files);
                material.files = [...material.files, ...newFiles];
            }

            if (req.body.commentsDisabled !== undefined) {
                material.commentsDisabled = req.body.commentsDisabled === "true";
            }
            if (req.body.mutedStudents) {
                material.mutedStudents = JSON.parse(req.body.mutedStudents);
            }
            if (req.body.visibleTo) {
                material.visibleTo = JSON.parse(req.body.visibleTo);
            }

            await material.save();
            res.status(201).json({ material: material.toObject() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

export default CourseMaterialRouter;
