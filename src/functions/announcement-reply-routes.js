import express from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";

import Announcement from "./announcement-model.js";
import AnnouncementReply from "./announcement-reply-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

const replyRoutes = express.Router();

/* ========= Upload dirs (re-use /uploads root) ========= */
const ROOT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "announcement", "replies");
function ensureDirSync(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensureDirSync(ROOT_UPLOAD_DIR);

/* ========= Multer (reply attachments) ========= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirSync(ROOT_UPLOAD_DIR);
    cb(null, ROOT_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const { name, ext } = path.parse(file.originalname || "file");
    const safeBase = (name || "file")
      .replace(/[^a-z0-9_\-]+/gi, "-")
      .replace(/-+/g, "-")
      .slice(0, 60);
    const uniq = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    cb(null, `${safeBase}-${uniq}${(ext || "").toLowerCase()}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

/* ========= Helpers (mirrors from announcementRoutes) ========= */
const isId = (id) => mongoose.Types.ObjectId.isValid(id);
const now = () => new Date();
const toBool = (v, d = false) => v === true || v === "true" || v === "1" || (v === undefined ? d : false);

/** Centralized author populate */
const AUTHOR_POP = { path: "author", select: "username name role _id" };

function collectBatchObjectIds(user) {
  const raw = new Set();
  if (user?.batch) raw.add(user.batch);
  if (user?.batchId) raw.add(user.batchId);
  if (Array.isArray(user?.batches)) user.batches.forEach((x) => raw.add(x));
  if (Array.isArray(user?.batchIds)) user.batchIds.forEach((x) => raw.add(x));
  if (user?.profile?.batch) raw.add(user.profile.batch);
  if (Array.isArray(user?.profile?.batches)) user.profile.batches.forEach((x) => raw.add(x));
  const ids = Array.from(raw).filter(isId);
  return ids.map((x) => new mongoose.Types.ObjectId(x));
}

function audienceFilter(user) {
  if (!user) return { $or: [{ audience: { $exists: false } }, { "audience.mode": "all" }] };
  if (user.role === "admin") return {};
  const ors = [{ audience: { $exists: false } }, { "audience.mode": "all" }];
  if (user.role === "teacher") {
    ors.push({
      "audience.mode": "faculty",
      $or: [
        { "audience.facultyIds": { $exists: false } },
        { "audience.facultyIds": { $size: 0 } },
        { "audience.facultyIds": user._id },
      ],
    });
  }
  if (user.role === "student") {
    const batchOids = collectBatchObjectIds(user);
    if (batchOids.length) {
      ors.push({ "audience.mode": "batches", "audience.batchIds": { $in: batchOids } });
    }
  }
  return { $or: ors };
}

function visibility({ adminIncludeUnpublished = false } = {}) {
  const n = now();
  const base = { isDeleted: false };
  if (adminIncludeUnpublished) return base;
  return {
    ...base,
    published: true,
    $and: [
      { $or: [{ publishAt: null }, { publishAt: { $lte: n } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: n } }] },
    ],
  };
}

// turn /uploads/... URL to absolute path so we can unlink on hard delete
function fileUrlToPath(u) {
  try {
    const UP = "/uploads/";
    let rel = String(u || "");
    const idx = rel.indexOf(UP);
    if (idx >= 0) rel = rel.slice(idx + UP.length);
    rel = rel.replace(/^\/?uploads\//i, "");
    return path.join(process.cwd(), "uploads", rel);
  } catch {
    return null;
  }
}
async function unlinkIfExists(p) { if (!p) return; try { await fs.promises.unlink(p); } catch { /* ignore */ } }

/* ========= Upload endpoint for reply attachments ========= */
// FormData key: "files"
replyRoutes.post(
  "/upload",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  upload.array("files", 10),
  (req, res) => {
    const files = (req.files || []).map((f) => {
      const uploadsRoot = path.join(process.cwd(), "uploads") + path.sep;
      const relFromUploads = f.path.startsWith(uploadsRoot)
        ? f.path.substring(uploadsRoot.length)
        : path.relative(path.join(process.cwd(), "uploads"), f.path);
      const url = `${req.protocol}://${req.get("host")}/uploads/${relFromUploads.replace(/\\/g, "/")}`;
      return { url, originalname: f.originalname, filetype: f.mimetype, size: f.size };
    });
    res.json({ files });
  }
);

// Multer error handler (local to this router)
replyRoutes.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  next(err);
});

/* ========= CREATE a reply (root or child) =========
   POST /announcement/:id/replies
   body: { contentHtml, files?, parent? }
*/
replyRoutes.post(
  "/announcement/:id/replies",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { contentHtml = "", files = [], parent = null } = req.body || {};
      if (!isId(id)) return res.status(400).json({ error: "Invalid announcement id" });

      // must be allowed to view the announcement to reply
      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;
      const ann = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      }).select("_id").lean();
      if (!ann) return res.status(404).json({ error: "Announcement not found or not visible" });

      if (parent) {
        if (!isId(parent)) return res.status(400).json({ error: "Invalid parent id" });
        const parentDoc = await AnnouncementReply.findById(parent).select("_id announcement").lean();
        if (!parentDoc) return res.status(404).json({ error: "Parent reply not found" });
        if (String(parentDoc.announcement) !== String(id))
          return res.status(400).json({ error: "Parent reply belongs to a different announcement" });
      }

      const created = await AnnouncementReply.create({
        announcement: id,
        parent: parent || null,
        author: req.user._id,
        contentHtml,
        files: Array.isArray(files) ? files : [],
      });

      // Return populated doc
      const populated = await AnnouncementReply.findById(created._id)
        .populate(AUTHOR_POP)
        .lean();

      res.status(201).json(populated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/* ========= LIST replies (root or children) =========
   GET /announcement/:id/replies?parent=<replyId|null>&page=1&limit=20&sort=asc|desc&includeDeleted=false
*/
replyRoutes.get(
  "/announcement/:id/replies",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid announcement id" });

      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;
      const ann = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      }).select("_id").lean();
      if (!ann) return res.status(404).json({ error: "Announcement not found or not visible" });

      const parent = req.query.parent === "null" || req.query.parent === undefined ? null : String(req.query.parent);
      if (parent && !isId(parent)) return res.status(400).json({ error: "Invalid parent id" });

      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
      const sortDir = String(req.query.sort || "desc").toLowerCase() === "asc" ? 1 : -1;
      const includeDeleted = isAdmin && toBool(req.query.includeDeleted, false);

      const cond = {
        announcement: new mongoose.Types.ObjectId(id),
        parent: parent ? new mongoose.Types.ObjectId(parent) : null,
        ...(includeDeleted ? {} : { isDeleted: false }),
      };

      const [items, total] = await Promise.all([
        AnnouncementReply.find(cond)
          .sort({ createdAt: sortDir, _id: sortDir })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate(AUTHOR_POP)
          .lean(),
        AnnouncementReply.countDocuments(cond),
      ]);

      res.json({ page, limit, total, data: items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ========= EDIT a reply (author or admin) =========
   PATCH /announcement-replies/:replyId
   body: { contentHtml?, files? }   (any provided field replaces existing)
*/
replyRoutes.patch(
  "/:replyId",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { replyId } = req.params;
      if (!isId(replyId)) return res.status(400).json({ error: "Invalid reply id" });

      const reply = await AnnouncementReply.findById(replyId);
      if (!reply) return res.status(404).json({ error: "Not found" });

      const isAdmin = req.user?.role === "admin";
      const isAuthor = String(reply.author) === String(req.user._id);
      if (!isAdmin && !isAuthor) return res.status(403).json({ error: "Not allowed" });

      const allowed = ["contentHtml", "files"];
      for (const key of allowed) {
        if (key in req.body) reply[key] = req.body[key];
      }
      reply.editedAt = now();
      await reply.save();

      // Return populated doc
      const populated = await AnnouncementReply.findById(reply._id)
        .populate(AUTHOR_POP)
        .lean();

      res.json(populated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/* ========= SOFT delete a reply (author or admin) =========
   DELETE /announcement-replies/:replyId?hard=true   (hard = admin only)
   - soft: sets isDeleted=true (keeps content/files)
   - hard (admin only): removes doc & unlinks uploaded files
*/
replyRoutes.delete(
  "/:replyId",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { replyId } = req.params;
      if (!isId(replyId)) return res.status(400).json({ error: "Invalid reply id" });

      const reply = await AnnouncementReply.findById(replyId).lean();
      if (!reply) return res.status(404).json({ error: "Not found" });

      const isAdmin = req.user?.role === "admin";
      const isAuthor = String(reply.author) === String(req.user._id);

      const hard = toBool(req.query.hard, false);
      if (hard) {
        if (!isAdmin) return res.status(403).json({ error: "Only admins can hard-delete" });

        // unlink attachments
        const allFiles = Array.isArray(reply.files) ? reply.files : [];
        await Promise.all(
          allFiles
            .map((f) => fileUrlToPath(f?.url))
            .filter(Boolean)
            .map((p) => unlinkIfExists(p))
        );
        await AnnouncementReply.deleteOne({ _id: replyId });
        return res.json({ ok: true, deleted: replyId, hard: true });
      }

      if (!isAdmin && !isAuthor) return res.status(403).json({ error: "Not allowed" });

      await AnnouncementReply.updateOne({ _id: replyId }, { $set: { isDeleted: true, editedAt: now() } });
      res.json({ ok: true, deleted: replyId, hard: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ========= RESTORE a soft-deleted reply (author or admin) =========
   POST /announcement-replies/:replyId/restore
*/
replyRoutes.post(
  "/:replyId/restore",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { replyId } = req.params;
      if (!isId(replyId)) return res.status(400).json({ error: "Invalid reply id" });

      const reply = await AnnouncementReply.findById(replyId);
      if (!reply) return res.status(404).json({ error: "Not found" });

      const isAdmin = req.user?.role === "admin";
      const isAuthor = String(reply.author) === String(req.user._id);
      if (!isAdmin && !isAuthor) return res.status(403).json({ error: "Not allowed" });

      reply.isDeleted = false;
      reply.editedAt = now();
      await reply.save();

      // Return populated doc so UI can refresh the row
      const populated = await AnnouncementReply.findById(reply._id)
        .populate(AUTHOR_POP)
        .lean();

      res.json({ ok: true, restored: replyId, data: populated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ========= CHILDREN of a reply (shortcut) =========
   GET /announcement-replies/:replyId/children?page=1&limit=20&sort=asc|desc&includeDeleted=false
*/
replyRoutes.get(
  "/:replyId/children",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { replyId } = req.params;
      if (!isId(replyId)) return res.status(400).json({ error: "Invalid reply id" });

      // No need to populate here; we only use _id and announcement
      const parent = await AnnouncementReply.findById(replyId)
        .select("_id announcement")
        .lean();
      if (!parent) return res.status(404).json({ error: "Parent reply not found" });

      // must be able to view the parent announcement to view children
      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;
      const ann = await Announcement.findOne({
        _id: parent.announcement,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      }).select("_id").lean();
      if (!ann) return res.status(404).json({ error: "Announcement not found or not visible" });

      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
      const sortDir = String(req.query.sort || "desc").toLowerCase() === "asc" ? 1 : -1;
      const includeDeleted = isAdmin && toBool(req.query.includeDeleted, false);

      const cond = {
        announcement: parent.announcement,
        parent: parent._id,
        ...(includeDeleted ? {} : { isDeleted: false }),
      };

      const [items, total] = await Promise.all([
        AnnouncementReply.find(cond)
          .sort({ createdAt: sortDir, _id: sortDir })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate(AUTHOR_POP)
          .lean(),
        AnnouncementReply.countDocuments(cond),
      ]);

      res.json({ page, limit, total, data: items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default replyRoutes;
