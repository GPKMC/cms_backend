import express from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";

import Announcement, { ANNOUNCEMENT_TYPES } from "./announcement-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import AnnouncementState from "./announcement-state-model.js";

const announcementRoutes = express.Router();

/* ============ Multer uploader ============ */
const ROOT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "announcement");
const IMAGES_DIR = path.join(ROOT_UPLOAD_DIR, "images");
const FILES_DIR  = path.join(ROOT_UPLOAD_DIR, "files");

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(IMAGES_DIR);
ensureDirSync(FILES_DIR);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImage = file.mimetype?.startsWith("image/") || IMAGE_EXTS.has(ext);
    const dest = isImage ? IMAGES_DIR : FILES_DIR;
    ensureDirSync(dest);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const { name, ext } = path.parse(file.originalname || "file");
    const safeBase = (name || "file")
      .replace(/[^a-z0-9_\-]+/gi, "-")
      .replace(/-+/g, "-")
      .slice(0, 60);
    const uniq = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    cb(null, `${safeBase}-${uniq}${(ext || "").toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB each
    files: 20
  }
});

// POST /announcement/upload  (expects FormData "files")
announcementRoutes.post(
  "/upload",
  authmiddleware,
  authorizedRole("admin"),
  upload.array("files", 20),
  (req, res) => {
    const files = (req.files || []).map((f) => {
      // build a public URL under /uploads/*
      const uploadsRoot = path.join(process.cwd(), "uploads") + path.sep;
      const relFromUploads = f.path.startsWith(uploadsRoot)
        ? f.path.substring(uploadsRoot.length)
        : path.relative(path.join(process.cwd(), "uploads"), f.path);
      const url = `${req.protocol}://${req.get("host")}/uploads/${relFromUploads.replace(/\\/g, "/")}`;

      return {
        url,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      };
    });

    res.json({ files });
  }
);

// Optional: Multer error handler scoped to this router
announcementRoutes.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

/* ============ helpers ============ */
const isId = (id) => mongoose.Types.ObjectId.isValid(id);
const now = () => new Date();
const toBool = (v, d = false) =>
  v === true || v === "true" || v === "1" || (v === undefined ? d : false);

function visibility({ adminIncludeUnpublished = false } = {}) {
  const n = now();
  const base = { isDeleted: false };
  if (adminIncludeUnpublished) return base;
  return {
    ...base,
    published: true,
    $and: [
      { $or: [{ publishAt: null }, { publishAt: { $lte: n } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: n } }] }
    ]
  };
}

/** Build an audience filter for the current user.
 *  - Admin: no restriction
 *  - Teacher: sees 'all' + 'faculty' (optionally targeted list or all faculty)
 *  - Student: sees 'all' + 'batches' containing their batch id(s)
 *  - Back-compat: docs without audience field are visible to everyone
 */
function collectBatchObjectIds(user) {
  // Normalize possible shapes: batch, batchId, batches, batchIds, profile.batch, etc.
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
  if (!user) {
    // Only 'all' or missing audience
    return { $or: [{ audience: { $exists: false } }, { "audience.mode": "all" }] };
  }
  if (user.role === "admin") return {}; // admins can see everything

  const ors = [
    { audience: { $exists: false } }, // back-compat
    { "audience.mode": "all" },
  ];

  if (user.role === "teacher") {
    // allow 'faculty' for all faculty OR targeted facultyIds contains user
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
      ors.push({
        "audience.mode": "batches",
        "audience.batchIds": { $in: batchOids },
      });
    }
  }

  // any other roles just get 'all' + back-compat
  return { $or: ors };
}

/* CREATE (Admin) */
announcementRoutes.post(
  "/",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const doc = await Announcement.create({
        ...req.body,
        postedBy: req.user?._id
      });
      res.status(201).json(doc);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/* LIST (All) ?type=&q=&page=1&limit=20&adminView=false */
announcementRoutes.get(
  "/",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { type, q } = req.query;
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
      const adminView =
        toBool(req.query.adminView, false) && req.user?.role === "admin";

      const cond = {
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      };

      if (type && ANNOUNCEMENT_TYPES.includes(type)) cond.type = type;
      if (q) cond.$text = { $search: String(q) };

      const [items, total] = await Promise.all([
        Announcement.find(cond)
          .sort({ pinned: -1, priority: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Announcement.countDocuments(cond)
      ]);

      const ids = items.map((i) => i._id);
      const states = await AnnouncementState.find({
        user: req.user._id,
        announcement: { $in: ids }
      })
        .select("announcement readAt archived archivedAt")
        .lean();
      const map = new Map(states.map((s) => [String(s.announcement), s]));

      res.json({
        page,
        limit,
        total,
        data: items.map((i) => ({
          ...i,
          myState:
            map.get(String(i._id)) || {
              readAt: null,
              archived: false,
              archivedAt: null
            }
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* READ single (All) */
announcementRoutes.get(
  "/:id",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const adminView =
        toBool(req.query.adminView, false) && req.user?.role === "admin";

      const cond = {
        _id: id,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      };

      const doc = await Announcement.findOne(cond).lean();
      if (!doc) return res.status(404).json({ error: "Not found" });

      const my = await AnnouncementState.findOne({
        user: req.user._id,
        announcement: id
      })
        .select("readAt archived archivedAt")
        .lean();

      res.json({
        ...doc,
        myState: my || { readAt: null, archived: false, archivedAt: null }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* UPDATE (Admin) */
announcementRoutes.patch(
  "/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const allowed = [
        "type",
        "title",
        "summary",
        "contentHtml",
        "images",
        "files",
        "links",
        "audience",       // <-- allow changing audience
        "published",
        "publishAt",
        "expiresAt",
        "pinned",
        "priority"
      ];
      const update = {};
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];

      const doc = await Announcement.findOneAndUpdate(
        { _id: id, isDeleted: false },
        update,
        { new: true, runValidators: true }
      );
      if (!doc) return res.status(404).json({ error: "Not found" });
      res.json(doc);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/* DELETE (soft, Admin) */
announcementRoutes.delete(
  "/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const doc = await Announcement.findOneAndUpdate(
        { _id: id, isDeleted: false },
        { isDeleted: true, published: false },
        { new: true }
      );
      if (!doc) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* MARK AS READ (Admin/Teacher/Student) */
announcementRoutes.post(
  "/:id/read",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      // must also be visible to user
      const visible = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: req.user.role === "admin" }),
        ...audienceFilter(req.user),
      })
        .select("_id")
        .lean();
      if (!visible) return res.status(404).json({ error: "Not found" });

      const state = await AnnouncementState.findOneAndUpdate(
        { user: req.user._id, announcement: id },
        { $set: { readAt: now() } },
        { new: true, upsert: true }
      ).lean();

      res.json({ ok: true, state });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ARCHIVE / UNARCHIVE (Admin/Teacher/Student) */
announcementRoutes.post(
  "/:id/archive",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const exists = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: req.user.role === "admin" }),
        ...audienceFilter(req.user),
      })
        .select("_id")
        .lean();
      if (!exists) return res.status(404).json({ error: "Not found" });

      const state = await AnnouncementState.findOneAndUpdate(
        { user: req.user._id, announcement: id },
        { $set: { archived: true, archivedAt: now() } },
        { new: true, upsert: true }
      ).lean();

      res.json({ ok: true, state });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

announcementRoutes.post(
  "/:id/unarchive",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const exists = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: req.user.role === "admin" }),
        ...audienceFilter(req.user),
      })
        .select("_id")
        .lean();
      if (!exists) return res.status(404).json({ error: "Not found" });

      const state = await AnnouncementState.findOneAndUpdate(
        { user: req.user._id, announcement: id },
        { $set: { archived: false }, $unset: { archivedAt: 1 } },
        { new: true, upsert: true }
      ).lean();

      res.json({ ok: true, state });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default announcementRoutes;
