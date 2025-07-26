// src/assignment/groupAssignments‐routes.js
import express from "express";
import { body, param, oneOf, validationResult } from "express-validator";
import mongoose from "mongoose";
import groupAssignmentModel from "./groupAssignment-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import upload from "../utlis/multer-config.js";

const GroupAssignmentRouter = express.Router();

// Helper to turn multer’s files into { url, originalname } objects
function makeFileUrls(files = []) {
  return files.map(file => {
    let rel = file.path
      .replace(process.cwd(), "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "/");
    return { url: rel, originalname: file.originalname };
  });
}

// If any of the validators fail, send 400 + JSON errors
const handleValidationErrors = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }
  next();
};
// ─── Helper to fetch assignment + group or 404 ─────────────────
async function loadAssignmentAndGroup(req, res, next) {
  try {
    const { id, groupIdx } = req.params;
    if (!mongoose.isValidObjectId(id) || isNaN(groupIdx)) {
      return res.status(400).json({ error: "Invalid ID or group index" });
    }
    const assignment = await groupAssignmentModel.findById(id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    req.assignment = assignment;
    req.group      = assignment.groups[Number(groupIdx)];
    if (!req.group) return res.status(404).json({ error: "Group not found" });

    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}


GroupAssignmentRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),

  // 1) File uploads via multer
  upload.fields([
    { name: "media" },
    { name: "documents" }
  ]),

  // 2) If groups arrived as JSON string, parse it
  (req, res, next) => {
    if (typeof req.body.groups === "string") {
      try { req.body.groups = JSON.parse(req.body.groups); }
      catch (_) { /* leave as string so validator will catch it */ }
    }

      if (Array.isArray(req.body.groups)) {
    req.body.groups = req.body.groups.map(g => {
      // turn "" into undefined so Mongoose will just ignore it
      if (typeof g.topic === "string" && g.topic.trim() === "") {
        delete g.topic;
      }
      return g;
    });
  }
  next();
  },

  // 3) Validation chain
  [
    // A) Must have either global or all-groups overrides:
    body().custom(body => {
      // detect any non‑empty global
      const hasGlobal =
        (typeof body.title   === "string" && body.title.trim() !== "") ||
        (typeof body.content === "string" && body.content.trim() !== "");

      if (hasGlobal) return true;

      // otherwise require groups
      if (!Array.isArray(body.groups) || body.groups.length === 0) {
        throw new Error("Either set a global title/content or create at least one group");
      }

      // and each group must have its own title+content:
      body.groups.forEach((g, i) => {
        if (typeof g.title   !== "string" || !g.title.trim())
          throw new Error(`Group #${i+1} needs its own title`);
        if (typeof g.content !== "string" || !g.content.trim())
          throw new Error(`Group #${i+1} needs its own content`);
      });

      return true;
    }),

    // B) Top‑level fields
    body("content")
      .optional({ checkFalsy: true })
      .isString().withMessage("Content must be a string when provided"),

    body("courseInstance")
      .isMongoId().withMessage("courseInstance must be a valid ID"),

    body("groups.*.topic")
  .optional({ checkFalsy: true })      // ← treats "", null, undefined all as “absent”
  .isMongoId().withMessage("Each group.topic, if provided, must be a valid ID"),


    body("dueDate")
      .optional()
      .isISO8601().withMessage("dueDate must be ISO8601")
      .custom(d => new Date(d) >= new Date())
      .withMessage("dueDate cannot be in the past"),

    body("points")
      .isInt({ min: 0 }).withMessage("Points must be a non‑negative integer"),

    // C) groups array
    body("groups")
      .isArray({ min: 1 }).withMessage("You must create at least one group"),

    // D) per‑group required fields
    body("groups.*.members")
      .isArray({ min: 1 }).withMessage("Each group needs at least one member"),
    body("groups.*.members.*")
      .isMongoId().withMessage("Each member ID must be a valid student ID"),

    body("groups.*.name")
      .isString().withMessage("Group name must be a string")
      .notEmpty().withMessage("Group name is required"),

    body("groups.*.task")
      .isString().withMessage("Group task must be a string")
      .notEmpty().withMessage("Group task is required"),

    // E) per‑group optional overrides
    body("groups.*.title")
      .optional().isString().withMessage("Group title must be a string"),

    body("groups.*.content")
      .optional().isString().withMessage("Group content must be a string"),

    // … you can add more validators for points, dueDate, media, etc.
  ],

  // 4) If any validation failed, return 400 + errors
  handleValidationErrors,

  // 5) Actual handler: assemble & save
  async (req, res) => {
    try {
      const media     = makeFileUrls(req.files?.media     || []);
      const documents = makeFileUrls(req.files?.documents || []);

      // build the payload
      const payload = {
        ...req.body,
        postedBy:  req.user.id,
        media,
        documents
      };

      // ────── NEW PATCH ──────
      // if user didn't set global title/content, copy from first group
      if (!payload.title && Array.isArray(payload.groups) && payload.groups.length) {
        payload.title   = payload.groups[0].title;
        payload.content = payload.groups[0].content;
      }

      const assignment = new groupAssignmentModel(payload);
      await assignment.save();

      res.status(201).json(assignment);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);




// --- 7. POST in group DISCUSSION ---
GroupAssignmentRouter.post(
  "/:id/group/:groupIdx/discussion",
  authmiddleware,
  loadAssignmentAndGroup,
  [body("message").isString().notEmpty()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { assignment, group } = req;
      group.discussion.push({
        user: req.user._id,
        message: req.body.message,
      });

      // update participation
      let part = group.participation.find(p => p.user.equals(req.user._id));
      if (part) part.messageCount++;
      else group.participation.push({
        user: req.user._id,
        contribution: "",
        files: [],
        messageCount: 1,
        discussionMinutes: 0
      });

      await assignment.save();
      res.json({ message: "Posted to discussion" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- 8. PATCH group PARTICIPATION/LOGSHEET ---
GroupAssignmentRouter.patch(
  "/:id/group/:groupIdx/participation/:userId",
  authmiddleware,
  loadAssignmentAndGroup,
  [
    param("userId").isMongoId(),
    // allow any of these fields
    oneOf([
      body("contribution").exists(),
      body("files").exists(),
      body("messageCount").exists(),
      body("discussionMinutes").exists()
    ], "At least one participation field required"),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { assignment, group } = req;
      const part = group.participation.find(p => p.user.equals(req.params.userId));
      if (part) {
        Object.assign(part, req.body);
      } else {
        group.participation.push({ user: req.params.userId, ...req.body });
      }
      await assignment.save();
      res.json({ message: "Participation updated" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- 9. PATCH group MARKS (teacher grading) ---
GroupAssignmentRouter.patch(
  "/:id/group/:groupIdx/marks",
  authmiddleware,
  authorizedRole("teacher"),
  loadAssignmentAndGroup,
  [
    body("marks").isNumeric(),
    body("feedback").optional().isString()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { assignment, group } = req;
      group.marks = req.body.marks;
      if (req.body.feedback !== undefined) group.feedback = req.body.feedback;
      await assignment.save();
      res.json({ message: "Marks updated", marks: group.marks });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- 10. GET participation/marks for a group ---
GroupAssignmentRouter.get(
  "/:id/group/:groupIdx/participation",
  authmiddleware,
  loadAssignmentAndGroup,
  async (req, res) => {
    try {
      const { group } = req;
      res.json({
        participation: group.participation,
        marks: group.marks,
        feedback: group.feedback
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

export default GroupAssignmentRouter;
