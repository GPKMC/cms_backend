import express from "express";
import { authmiddleware } from "../users/user-middleware.js"; // Adjust path as needed
import courseComment from "./courseComment-model.js";
import Assignment from "../assignment/assignmentModel.js"; // <-- Use your actual assignment model path
import notificationModel from "../functions/notification-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js";

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

    // Fetch the assignment's comment settings + title!
    const assignment = await Assignment.findById(assignmentId).select(
      "title commentsDisabled mutedStudents courseInstance postedBy visibleTo"
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

    // Populate postedBy so username is available
    await newComment.populate("postedBy", "username email");

    // --------- NOTIFICATION LOGIC ---------
    let recipients = [];

    // Notify assignment creator, unless it's the commenter
    if (assignment.postedBy && String(assignment.postedBy) !== String(userId)) {
      recipients.push(assignment.postedBy.toString());
    }

    // If visibleTo is empty, all students in the courseInstance should get notified
    if (!assignment.visibleTo || assignment.visibleTo.length === 0) {
      // You probably want to get ALL students in this courseInstance
      const courseInstance = await CourseInstance.findById(assignment.courseInstance).select("batch");
      if (courseInstance) {
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
      // Also notify all visibleTo users except the commenter
      assignment.visibleTo.forEach(uid => {
        if (String(uid) !== String(userId) && !recipients.includes(String(uid))) {
          recipients.push(String(uid));
        }
      });
    }

    // Only create notification if someone to notify
    if (recipients.length > 0) {
      await notificationModel.create({
        courseInstance: assignment.courseInstance,
        type: "comment",
        refId: newComment._id, // Or assignmentId if you want to group by assignment
        title: "New comment on assignment",
        message: `${newComment.postedBy?.username || "Someone"} commented on assignment "${assignment.title || ""}": "${newComment.content.slice(0, 60)}..."`,
        createdBy: userId,
        recipients,
      });
    }

    res.status(201).json({
      message: "Comment posted!",
      comment: newComment,
    });
  } catch (err) {
    console.error(err); // <--- Add this line!
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
