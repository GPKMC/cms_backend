import express from "express";
import { authmiddleware } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import Assignment from "../assignment/assignmentModel.js"; // <-- Use your actual assignment model path

const assignmentCommentRouter = express.Router();

/**
 * Get all comments for an assignment
 * GET /api/assignment-comments/:assignmentId
 * Public
 */
assignmentCommentRouter.get("/assignment-comments/:assignmentId", async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const comments = await courseComment.find({
      type: "assignment",
      contentId: assignmentId,
    })
      .sort({ createdAt: -1 })
      .populate("postedBy", "username email");
    res.json(comments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Post a comment on an assignment
 * POST /api/assignment-comments/:assignmentId
 * Body: { content: string }
 * Authenticated users only
 */
assignmentCommentRouter.post("/assignment-comments/:assignmentId", authmiddleware, async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    // Fetch the assignment's comment settings
    const assignment = await Assignment.findById(assignmentId).select(
      "commentsDisabled mutedStudents courseInstance"
    );
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    if (assignment.commentsDisabled) {
      return res.status(403).json({ message: "Comments are disabled for this assignment." });
    }

    if (
      Array.isArray(assignment.mutedStudents) &&
      assignment.mutedStudents.map(id => String(id)).includes(String(userId))
    ) {
      return res.status(403).json({ message: "You are muted for this assignment." });
    }

    // Create comment
    const newComment = await courseComment.create({
      content,
      courseInstance: assignment.courseInstance,
      type: "assignment",
      contentId: assignmentId,
      postedBy: userId,
    });

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
 * Update a comment
 * PATCH /api/assignment-comments/:commentId
 * Body: { content: string }
 * Only the comment owner can edit
 */
assignmentCommentRouter.patch("/assignment-comments/:commentId", authmiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    const comment = await courseComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found." });
    }
    if (String(comment.postedBy) !== String(userId)) {
      return res.status(403).json({ message: "You can only edit your own comments." });
    }

    comment.content = content;
    await comment.save();
    await comment.populate("postedBy", "username email");

    res.json({
      message: "Comment updated!",
      comment,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Delete a comment
 * DELETE /api/assignment-comments/:commentId
 * Only the comment owner can delete
 */
assignmentCommentRouter.delete("/assignment-comments/:commentId", authmiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;

    const comment = await courseComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found." });
    }
    if (String(comment.postedBy) !== String(userId)) {
      return res.status(403).json({ message: "You can only delete your own comments." });
    }

    await comment.deleteOne();

    res.json({ message: "Comment deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default assignmentCommentRouter;
