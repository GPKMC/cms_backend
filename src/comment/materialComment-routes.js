import express from "express";

import { authmiddleware, authorizedRole } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";
import notificationModel from "../functions/notification-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";

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
// TOP OF FILE!
// At the top of your file

materialCommentRouter.post(
  "/material-comments/:materialId",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const { materialId } = req.params;
      const { content } = req.body;
      const userId = req.user._id;

      console.log("materialId:", materialId);
      console.log("userId:", userId);
      console.log("content:", content);

      // Fetch material info (with visibleTo, postedBy, courseInstance, title)
      const material = await courseMaterialsModel.findById(materialId).select(
        "title commentsDisabled mutedStudents courseInstance postedBy visibleTo"
      );
      console.log("material found:", material);

      if (!material) {
        console.log("Material not found.");
        return res.status(404).json({ message: "Material not found." });
      }
      if (material.commentsDisabled) {
        console.log("Comments are disabled for this material.");
        return res.status(403).json({ message: "Comments are disabled for this material." });
      }
      if (
        Array.isArray(material.mutedStudents) &&
        material.mutedStudents.map(id => String(id)).includes(String(userId))
      ) {
        console.log("You are muted for this material.");
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
      await newComment.populate("postedBy", "username email");
      console.log("newComment created:", newComment);

      // ----- NOTIFICATION LOGIC -----
      let recipients = [];

// Notify material poster (teacher), unless it's the commenter
if (
  material.postedBy &&
  String(material.postedBy) !== String(userId)
) {
  recipients.push(String(material.postedBy));
}

// Get all students if visibleTo is empty, else only visibleTo
if (!material.visibleTo || material.visibleTo.length === 0) {
  // Get the courseInstance and its batch
  const courseInstance = await CourseInstance.findById(material.courseInstance).select("batch");
  if (courseInstance) {
    // Fetch all students in that batch
    const students = await User.find({
      role: "student",
      batch: courseInstance.batch,
    }).select("_id");
    recipients = [
      ...recipients,
      ...students
        .filter((stu) => String(stu._id) !== String(userId))
        .map((stu) => String(stu._id)),
    ];
  }
} else {
  // Only notify visibleTo students except commenter
  recipients = material.visibleTo
    .map(uid => String(uid))
    .filter(uid => uid !== String(userId));
}

// Only create notification if someone to notify
if (recipients.length > 0) {
  await notificationModel.create({
    courseInstance: material.courseInstance,
    type: "comment",
    refId: newComment._id,
    title: "New comment on material",
    message: `${newComment.postedBy?.username || "Someone"} commented on material "${material.title || ""}": "${newComment.content.slice(0, 60)}..."`,
    createdBy: userId,
    recipients,
  });
}

      res.status(201).json({
        message: "Comment posted!",
        comment: newComment,
      });
    } catch (err) {
      console.error("Error in material-comments route:", err);
      res.status(500).json({ message: err.message });
    }
  }
);




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
