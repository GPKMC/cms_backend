// routes/teacher-group.routes.js
import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import groupSubmissionModel from "./groupSubmission-model.js";
import groupAssignmentModel from "./groupAssignment-model.js";

const GroupGradeRouter = express.Router();

/** Auth helper: allow ONLY the teacher who posted the group assignment */
function isTeacherForGroupAssignment(gaDoc, user) {
  if (!user || user.role !== "teacher" || !gaDoc) return false;
  const uid = user._id?.toString?.();
  const postedBy = gaDoc.postedBy?.toString?.();
  return Boolean(postedBy && uid && postedBy === uid);
}

/**
 * PATCH /teacher/group-assignments/:gaId/accepting
 * Toggle acceptingSubmissions and/or set closeAt for a group assignment.
 * Body: { acceptingSubmissions?: boolean, closeAt?: string|null, closeNow?: boolean }
 */
GroupGradeRouter.patch(
  "/group-assignments/:gaId/accepting",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { gaId } = req.params;
      const { acceptingSubmissions, closeAt, closeNow } = req.body;

      const ga = await groupAssignmentModel
        .findById(gaId)
        .select("postedBy title acceptingSubmissions closeAt points groups");
      if (!ga) return res.status(404).json({ error: "Group assignment not found." });
      if (!isTeacherForGroupAssignment(ga, req.user)) {
        return res.status(403).json({ error: "Not authorized for this group assignment." });
      }

      if (typeof acceptingSubmissions === "boolean") {
        ga.acceptingSubmissions = acceptingSubmissions;

        // ✅ If teacher is reopening, clear the closeAt date
        if (acceptingSubmissions === true) {
          ga.closeAt = null;
        }
      }

      if (closeNow === true) {
        ga.acceptingSubmissions = false;
        ga.closeAt = new Date();
      } else if (closeAt !== undefined) {
        ga.closeAt = closeAt ? new Date(closeAt) : null;
      }

      await ga.save();
      return res.status(200).json({
        message: "Group assignment submission settings updated.",
        assignment: {
          _id: ga._id,
          title: ga.title,
          acceptingSubmissions: ga.acceptingSubmissions,
          closeAt: ga.closeAt,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);


/**
 * GET /teacher/group-assignments/:gaId/groups
 * List all groups for a group assignment with members (assigned) and submission counts.
 * Also returns mirrored group-level marks and feedback.
 */
GroupGradeRouter.get(
  "/group-assignments/:gaId/groups",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { gaId } = req.params;

      const ga = await groupAssignmentModel
        .findById(gaId)
        .select("postedBy title groups acceptingSubmissions closeAt points")
        .populate("groups.members", "username email");
      if (!ga) return res.status(404).json({ error: "Group assignment not found." });
      if (!isTeacherForGroupAssignment(ga, req.user)) {
        return res.status(403).json({ error: "Not authorized for this group assignment." });
      }

      // Count submissions per group
      const subs = await groupSubmissionModel.aggregate([
        { $match: { groupAssignmentId: ga._id } },
        { $group: { _id: "$groupId", count: { $sum: 1 } } },
      ]);
      const counts = new Map(subs.map(s => [String(s._id), s.count]));

      const groups = (ga.groups || []).map(g => ({
        _id: g._id,
        name: g.name,
        task: g.task,
        // include mirrored grade/feedback stored on the group:
        marks: g.marks ?? null,
        feedback: g.feedback ?? "",
        members: (g.members || []).map(m => ({
          _id: m._id, username: m.username, email: m.email,
        })),
        submissionCount: counts.get(String(g._id)) || 0,
      }));

      return res.status(200).json({
        assignment: {
          _id: ga._id,
          title: ga.title,
          points: ga.points,
          acceptingSubmissions: ga.acceptingSubmissions,
          closeAt: ga.closeAt,
        },
        groupsCount: groups.length,
        groups,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * GET /teacher/group-assignments/:gaId/groups/:groupId/submissions
 * Group-wise teacher view:
 *  - returns ALL submissions for the group
 *  - optionally members with no submission (includeAssigned=1)
 */
GroupGradeRouter.get(
  "/group-assignments/:gaId/groups/:groupId/submissions",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { gaId, groupId } = req.params;
      const includeAssigned = String(req.query.includeAssigned || "0") === "1";

      const ga = await groupAssignmentModel
        .findById(gaId)
        .select("postedBy title groups acceptingSubmissions closeAt points")
        .populate("groups.members", "username email");
      if (!ga) return res.status(404).json({ error: "Group assignment not found." });
      if (!isTeacherForGroupAssignment(ga, req.user)) {
        return res.status(403).json({ error: "Not authorized for this group assignment." });
      }

      const group = (ga.groups || []).find(g => String(g._id) === String(groupId));
      if (!group) return res.status(404).json({ error: "Group not found on this assignment." });

      const submissions = await groupSubmissionModel
        .find({ groupAssignmentId: gaId, groupId })
        .select("submittedBy files submittedAt grade feedback plagiarismPercentage plagiarismDetails status")
        .populate("submittedBy", "username email")
        .sort({ submittedAt: 1 });

      let assignedOnly = [];
      if (includeAssigned) {
        const subByUser = new Set(
          submissions.map(s => String(s.submittedBy?._id || s.submittedBy))
        );
        assignedOnly = (group.members || [])
          .filter(m => !subByUser.has(String(m._id)))
          .map(m => ({
            _id: `assigned:${m._id}`,
            submittedBy: { _id: m._id, username: m.username, email: m.email },
            files: [],
            submittedAt: null,
            grade: null,
            feedback: "",
            plagiarismPercentage: 0,
            status: "assigned",
          }));
      }

      return res.status(200).json({
        assignment: {
          _id: ga._id,
          title: ga.title,
          points: ga.points,
          acceptingSubmissions: ga.acceptingSubmissions,
          closeAt: ga.closeAt,
        },
        group: {
          _id: group._id,
          name: group.name,
          task: group.task,
          members: (group.members || []).map(m => ({
            _id: m._id, username: m.username, email: m.email,
          })),
          // include current mirrored marks/feedback on the group
          marks: group.marks ?? null,
          feedback: group.feedback ?? "",
        },
        count: submissions.length + assignedOnly.length,
        submissions: [...assignedOnly, ...submissions],
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * GET /teacher/group-submissions/:submissionId
 * Teacher view a single group submission (all details)
 */
GroupGradeRouter.get(
  "/group-submissions/:submissionId",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { submissionId } = req.params;

      const submission = await groupSubmissionModel
        .findById(submissionId)
        .populate("submittedBy", "username email")
        .populate(
          "groupAssignmentId",
          "postedBy title points dueDate acceptingSubmissions closeAt"
        )
        .select(
          "files combinedText submittedAt grade feedback plagiarismPercentage plagiarismDetails status groupId groupAssignmentId submittedBy"
        );

      if (!submission) return res.status(404).json({ error: "Submission not found." });
      if (!isTeacherForGroupAssignment(submission.groupAssignmentId, req.user)) {
        return res.status(403).json({ error: "Not authorized for this group assignment." });
      }

      return res.status(200).json({ submission });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * PATCH /teacher/group-submissions/:submissionId/grade
 * Grade & feedback a group submission.
 * Mirrors the grade/feedback into the parent GroupAssignment.groups[].marks / .feedback.
 * Body: { grade?: number|null, feedback?: string }
 */
// PATCH /teacher/group-assignments/:gaId/groups/:groupId/grade
GroupGradeRouter.patch(
  "/group-assignments/:gaId/groups/:groupId/grade",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { gaId, groupId } = req.params;
      const { grade, feedback } = req.body;

      const ga = await groupAssignmentModel
        .findById(gaId)
        .select("postedBy points groups");
      if (!ga) return res.status(404).json({ error: "Group assignment not found." });
      if (!isTeacherForGroupAssignment(ga, req.user))
        return res.status(403).json({ error: "Not authorized." });

      // validate grade
      if (grade != null) {
        const max = ga.points ?? null;
        if (typeof grade !== "number" || Number.isNaN(grade))
          return res.status(400).json({ error: "Grade must be a number." });
        if (max != null && (grade < 0 || grade > max))
          return res.status(400).json({ error: `Grade must be between 0 and ${max}.` });
      }

      // update group-level marks & feedback
      const g = ga.groups.id(groupId);
      if (!g) return res.status(404).json({ error: "Group not found on this assignment." });

      if (grade != null) g.marks = grade;
      if (feedback !== undefined) g.feedback = String(feedback ?? "");

      await ga.save();

      // OPTIONAL: mirror onto all submissions for this group so rows show the same
      await groupSubmissionModel.updateMany(
        { groupAssignmentId: gaId, groupId },
        {
          ...(grade != null ? { grade } : {}),
          ...(feedback !== undefined ? { feedback: String(feedback ?? "") } : {}),
        }
      );

      return res.status(200).json({
        message: "Group grade updated.",
        group: { _id: g._id, marks: g.marks ?? null, feedback: g.feedback ?? "" },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);


/**
 * DELETE /teacher/group-submissions/:submissionId/unsubmit
 * Teacher (who posted the GA) can delete a submission.
 */
GroupGradeRouter.delete(
  "/group-submissions/:submissionId/unsubmit",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { submissionId } = req.params;

      const submission = await groupSubmissionModel
        .findById(submissionId)
        .populate("groupAssignmentId", "postedBy");
      if (!submission) return res.status(404).json({ error: "Submission not found." });
      if (!isTeacherForGroupAssignment(submission.groupAssignmentId, req.user)) {
        return res.status(403).json({ error: "Not authorized for this group assignment." });
      }

      await groupSubmissionModel.deleteOne({ _id: submissionId });
      return res.status(200).json({ message: "Submission unsubmitted (deleted) successfully." });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

export default GroupGradeRouter;
