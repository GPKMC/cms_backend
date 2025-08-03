import express from "express";

import { authmiddleware } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";

const materialCommentRouter = express.Router();

/**
 * Get all comments for a material
 * GET /api/material-comments/:materialId
 * Public (all can view)
 */
materialCommentRouter.get("/material-comments/:materialId", async (req, res) => {
  try {
    const { materialId } = req.params;
    const comments = await courseComment.find({
      type: "material",
      contentId: materialId,
    })
      .sort({ createdAt: -1 }) // DESCENDING: latest first
      .populate("postedBy", "username email");
    res.json(comments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/**
 * Post a comment on a material
 * POST /api/material-comments/:materialId
 * Body: { content: string }
 * Authenticated users only
 */
materialCommentRouter.post("/material-comments/:materialId", authmiddleware, async (req, res) => {
  try {
    const { materialId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    // Fetch the material's comment settings
    const material = await courseMaterialsModel.findById(materialId).select(
      "commentsDisabled mutedStudents courseInstance"
    );

    if (!material) {
      return res.status(404).json({ message: "Material not found." });
    }

    // Comments disabled?
    if (material.commentsDisabled) {
      return res.status(403).json({ message: "Comments are disabled for this material." });
    }

    // Muted for this material?
    if (
      Array.isArray(material.mutedStudents) &&
      material.mutedStudents.map(id => String(id)).includes(String(userId))
    ) {
      return res.status(403).json({ message: "You are muted for this material." });
    }

    // Create comment
    const newComment = await courseComment.create({
      content,
      courseInstance: material.courseInstance,
      type: "material",
      contentId: materialId,
      postedBy: userId,
    });

    // Populate for response
    await newComment.populate("postedBy", "username email");

    res.status(201).json({
      message: "Comment posted!",
      comment: newComment,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
/**
 * Update (edit) a material comment
 * PATCH /api/material-comments/:commentId
 * Body: { content: string }
 * Authenticated, only owner can edit
 */
materialCommentRouter.patch("/material-comments/:commentId", authmiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    const comment = await courseComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found." });
    }

    // Only allow the owner to edit
    if (String(comment.postedBy) !== String(userId)) {
      return res.status(403).json({ message: "You can only edit your own comments." });
    }

    // Update content (add any extra validation you want here)
    comment.content = content;
    await comment.save();
    await comment.populate("postedBy", "username email");

    res.json({
      message: "Comment updated!",
      comment
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Delete a material comment
 * DELETE /api/material-comments/:commentId
 * Authenticated, only owner can delete
 */
materialCommentRouter.delete("/material-comments/:commentId", authmiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;

    const comment = await courseComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found." });
    }

    // Only allow the owner to delete
    if (String(comment.postedBy) !== String(userId)) {
      return res.status(403).json({ message: "You can only delete your own comments." });
    }

    await comment.deleteOne();

    res.json({ message: "Comment deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default materialCommentRouter;
