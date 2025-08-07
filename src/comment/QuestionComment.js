import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import questionModel from "../question/question-model.js";
import notificationModel from "../functions/notification-model.js";
import User from "../users/user-model.js";
import CourseInstance from "../course/courseinstance-model.js";

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
questionCommentRouter.post(
  "/question-comments/:questionId",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const { questionId } = req.params;
      const { content } = req.body;
      const userId = req.user._id;

      // Fetch question settings (+title, postedBy, visibleTo)
      const question = await questionModel.findById(questionId).select(
        "title commentsDisabled mutedStudents courseInstance postedBy visibleTo"
      );
      console.log("Fetched question:", question);

      if (!question) {
        return res.status(404).json({ message: "Question not found." });
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
      console.log("Created comment:", newComment);

      // ----- NOTIFICATION LOGIC -----
      let recipients = [];

      // 1. Notify question poster (teacher/student), unless commenter
      if (question.postedBy && String(question.postedBy) !== String(userId)) {
        recipients.push(String(question.postedBy));
      }

      // 2. If visibleTo is empty, notify all students in this courseInstance
      if (!question.visibleTo || question.visibleTo.length === 0) {
        // Find courseInstance, then batch, then students with that batch
        const courseInstance = await CourseInstance.findById(question.courseInstance).select("batch");
        console.log("Found courseInstance:", courseInstance);

        if (courseInstance) {
          const students = await User.find({
            role: "student",
            batch: courseInstance.batch,
          }).select("_id");
          console.log("Found students for batch:", students);

          recipients = [
            ...recipients,
            ...students
              .filter(stu => String(stu._id) !== String(userId))
              .map(stu => String(stu._id))
          ];
        }
      } else {
        // Only notify visibleTo students except commenter
        question.visibleTo.forEach(uid => {
          if (String(uid) !== String(userId) && !recipients.includes(String(uid))) {
            recipients.push(String(uid));
          }
        });
      }

      console.log("Notification recipients:", recipients);

      // Only create notification if someone to notify
      if (recipients.length > 0) {
        await notificationModel.create({
          courseInstance: question.courseInstance,
          type: "comment",
          refId: newComment._id,
          title: "New comment on question",
          message: `${newComment.postedBy.username} commented on question "${question.title || ""}": "${newComment.content.slice(0, 60)}..."`,
          createdBy: userId,
          recipients,
        });
        console.log("Notification created!");
      } else {
        console.log("No recipients for notification, skipping creation.");
      }

      res.status(201).json({
        message: "Comment posted!",
        comment: newComment,
      });
    } catch (err) {
      console.error("Error in question-comments route:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

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
