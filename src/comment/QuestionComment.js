import express from "express";
import { authmiddleware } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import questionModel from "../question/question-model.js";

const questionCommentRouter = express.Router();

/**
 * Get all comments for an question
 * GET /api/question-comments/:questionId
 * Public
 */
questionCommentRouter.get("/question-comments/:questionId", async (req, res) => {
  try {
    const { questionId } = req.params;
    const comments = await courseComment.find({
      type: "question",
      contentId: questionId,
    })
      .sort({ createdAt: -1 })
      .populate("postedBy", "username email");
    res.json(comments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Post a comment on an question
 * POST /api/question-comments/:questionId
 * Body: { content: string }
 * Authenticated users only
 */
questionCommentRouter.post("/question-comments/:questionId", authmiddleware, async (req, res) => {
  try {
    const { questionId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    // Fetch the question's comment settings
    const question = await questionModel.findById(questionId).select(
      "commentsDisabled mutedStudents courseInstance"
    );
    if (!question) {
      return res.status(404).json({ message: "question not found." });
    }

    if (question.commentsDisabled) {
      return res.status(403).json({ message: "Comments are disabled for this question." });
    }

    if (
      Array.isArray(question.mutedStudents) &&
      question.mutedStudents.map(id => String(id)).includes(String(userId))
    ) {
      return res.status(403).json({ message: "You are muted for this question." });
    }

    // Create comment
    const newComment = await courseComment.create({
      content,
      courseInstance: question.courseInstance,
      type: "question",
      contentId: questionId,
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
 * PATCH /api/question-comments/:commentId
 * Body: { content: string }
 * Only the comment owner can edit
 */
questionCommentRouter.patch("/question-comments/:commentId", authmiddleware, async (req, res) => {
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
 * DELETE /api/question-comments/:commentId
 * Only the comment owner can delete
 */
questionCommentRouter.delete("/question-comments/:commentId", authmiddleware, async (req, res) => {
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

export default questionCommentRouter;
