import express from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";

import Announcement, { ANNOUNCEMENT_TYPES } from "./announcement-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import AnnouncementState from "./announcement-state-model.js";

const announcementRoutes = express.Router();

/* ========= Upload dirs ========= */
const ROOT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "announcement");
const IMAGES_DIR = path.join(ROOT_UPLOAD_DIR, "images");
const FILES_DIR = path.join(ROOT_UPLOAD_DIR, "files");

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(IMAGES_DIR);
ensureDirSync(FILES_DIR);

/* ========= Multer ========= */
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
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

/* ========= Helpers ========= */
const isId = (id) => mongoose.Types.ObjectId.isValid(id);
const now = () => new Date();
const toBool = (v, d = false) => v === true || v === "true" || v === "1" || (v === undefined ? d : false);

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

function computeStatus(doc) {
  const t = Date.now();
  const pub = !!doc.published;
  const starts = !doc.publishAt || new Date(doc.publishAt).getTime() <= t;
  const notExpired = !doc.expiresAt || new Date(doc.expiresAt).getTime() > t;
  if (!pub) return "draft";
  if (!starts) return "scheduled";
  if (!notExpired) return "expired";
  return "live";
}

// turn a file URL pointing under /uploads/... into an absolute FS path
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
async function unlinkIfExists(p) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* ignore */ }
}

/* ========= ROUTES (ORDER MATTERS!) ========= */
// In your main server entry, be sure to expose uploads:
// app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* ---- Create ---- */
announcementRoutes.post("/", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const doc = await Announcement.create({ ...req.body, postedBy: req.user?._id });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---- Upload ---- */
announcementRoutes.post(
  "/upload",
  authmiddleware,
  authorizedRole("admin"),
  upload.array("files", 20),
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

// Multer error handler
announcementRoutes.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  next(err);
});

/* ---- List (admins see ALL non-deleted by default) ---- */
announcementRoutes.get("/", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const { type, q } = req.query;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const isAdmin = req.user?.role === "admin";
    const adminView = isAdmin ? toBool(req.query.adminView, true) : false;

    const cond = { ...visibility({ adminIncludeUnpublished: adminView }), ...audienceFilter(req.user) };
    if (type && ANNOUNCEMENT_TYPES.includes(type)) cond.type = type;
    if (q) cond.$text = { $search: String(q) };

    const [items, total] = await Promise.all([
      Announcement.find(cond)
        .sort({ pinned: -1, priority: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Announcement.countDocuments(cond),
    ]);

    const ids = items.map((i) => i._id);
    const states = await AnnouncementState.find({ user: req.user._id, announcement: { $in: ids } })
      .select("announcement readAt archived archivedAt")
      .lean();
    const map = new Map(states.map((s) => [String(s.announcement), s]));

    res.json({
      page,
      limit,
      total,
      data: items.map((i) => ({
        ...i,
        myState: map.get(String(i._id)) || { readAt: null, archived: false, archivedAt: null },
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- Folder counts ---- */
announcementRoutes.get("/folder-counts", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const user = req.user;
    const userId = user?._id;
    const now = new Date();

    const baseMatch = { isDeleted: false, ...audienceFilter(user) };

    const pipeline = [
      { $match: baseMatch },
      {
        $addFields: {
          _status: {
            $switch: {
              branches: [
                { case: { $eq: ["$published", false] }, then: "draft" },
                {
                  case: {
                    $and: [{ $ne: ["$published", false] }, { $ne: ["$publishAt", null] }, { $gt: ["$publishAt", now] }],
                  },
                  then: "scheduled",
                },
                {
                  case: {
                    $and: [{ $ne: ["$published", false] }, { $ne: ["$expiresAt", null] }, { $lte: ["$expiresAt", now] }],
                  },
                  then: "expired",
                },
              ],
              default: "live",
            },
          },
        },
      },
      {
        $lookup: {
          from: "announcementstates",
          let: { annId: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$announcement", "$$annId"] }, { $eq: ["$user", userId] }] } } },
            { $project: { _id: 0, archived: 1 } },
          ],
          as: "_state",
        },
      },
      { $addFields: { _archived: { $ifNull: [{ $first: "$_state.archived" }, false] } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          drafts: { $sum: { $cond: [{ $eq: ["$_status", "draft"] }, 1, 0] } },
          scheduled: { $sum: { $cond: [{ $eq: ["$_status", "scheduled"] }, 1, 0] } },
          expired: { $sum: { $cond: [{ $eq: ["$_status", "expired"] }, 1, 0] } },
          live: { $sum: { $cond: [{ $eq: ["$_status", "live"] }, 1, 0] } },
          archived: { $sum: { $cond: [{ $eq: ["$_archived", true] }, 1, 0] } },
          inbox: {
            $sum: {
              $cond: [{ $and: [{ $in: ["$_status", ["live", "scheduled"]] }, { $eq: ["$_archived", false] }] }, 1, 0],
            },
          },
        },
      },
      { $project: { _id: 0, all: "$total", drafts: 1, scheduled: 1, expired: 1, live: 1, archived: 1, inbox: 1 } },
    ];

    const [row] = await Announcement.aggregate(pipeline);
    res.json(row || { all: 0, drafts: 0, scheduled: 0, expired: 0, live: 0, archived: 0, inbox: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- ID-scoped extras ---- */
announcementRoutes.get("/:id/state", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid id" });
    const visible = await Announcement.findOne({
      _id: id,
      ...visibility({ adminIncludeUnpublished: req.user.role === "admin" }),
      ...audienceFilter(req.user),
    })
      .select("_id")
      .lean();
    if (!visible) return res.status(404).json({ error: "Not found" });

    const state = await AnnouncementState.findOne({ user: req.user._id, announcement: id })
      .select("readAt archived archivedAt")
      .lean();

    res.json(state || { readAt: null, archived: false, archivedAt: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

announcementRoutes.get("/:id/stats", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

    const exists = await Announcement.findOne({ _id: id, isDeleted: false, ...audienceFilter(req.user) })
      .select("_id")
      .lean();
    if (!exists) return res.status(404).json({ error: "Not found" });

    const [agg] = await AnnouncementState.aggregate([
      { $match: { announcement: new mongoose.Types.ObjectId(id) } },
      {
        $group: {
          _id: "$announcement",
          readCount: { $sum: { $cond: [{ $ifNull: ["$readAt", false] }, 1, 0] } },
          archivedCount: { $sum: { $cond: [{ $eq: ["$archived", true] }, 1, 0] } },
          usersWithState: { $addToSet: "$user" },
        },
      },
    ]);

    res.json({
      readCount: agg?.readCount || 0,
      archivedCount: agg?.archivedCount || 0,
      usersWithState: (agg?.usersWithState || []).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- Notification-style detail ---- */
announcementRoutes.get(
  "/:id/notification-details",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });
      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;

      const cond = { _id: id, ...visibility({ adminIncludeUnpublished: adminView }), ...audienceFilter(req.user) };
      const doc = await Announcement.findOne(cond).lean();
      if (!doc) return res.status(404).json({ error: "Not found" });

      const my = await AnnouncementState.findOne({ user: req.user._id, announcement: id })
        .select("readAt archived archivedAt")
        .lean();

      const [agg] = await AnnouncementState.aggregate([
        { $match: { announcement: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: "$announcement",
            readCount: { $sum: { $cond: [{ $ifNull: ["$readAt", false] }, 1, 0] } },
            archivedCount: { $sum: { $cond: [{ $eq: ["$archived", true] }, 1, 0] } },
          },
        },
      ]);

      res.json({
        ...doc,
        status: computeStatus(doc),
        myState: my || { readAt: null, archived: false, archivedAt: null },
        counts: { readCount: agg?.readCount || 0, archivedCount: agg?.archivedCount || 0 },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---- CRUD + state ---- */
// Read single
announcementRoutes.get("/:id", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid id" });
    const isAdmin = req.user?.role === "admin";
    const adminView = isAdmin ? toBool(req.query.adminView, true) : false;
    const cond = { _id: id, ...visibility({ adminIncludeUnpublished: adminView }), ...audienceFilter(req.user) };

    const doc = await Announcement.findOne(cond).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const my = await AnnouncementState.findOne({ user: req.user._id, announcement: id })
      .select("readAt archived archivedAt")
      .lean();

    res.json({ ...doc, myState: my || { readAt: null, archived: false, archivedAt: null } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update
announcementRoutes.patch("/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
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
      "audience",
      "published",
      "publishAt",
      "expiresAt",
      "pinned",
      "priority",
    ];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];

    const doc = await Announcement.findOneAndUpdate({ _id: id, isDeleted: false }, update, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// HARD delete (remove doc, states, & any uploaded files)
announcementRoutes.delete("/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

    const doc = await Announcement.findById(id).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const allFiles = [
      ...(Array.isArray(doc.images) ? doc.images : []),
      ...(Array.isArray(doc.files) ? doc.files : []),
    ];
    await Promise.all(
      allFiles
        .map((f) => fileUrlToPath(f?.url))
        .filter(Boolean)
        .map((p) => unlinkIfExists(p))
    );

    await AnnouncementState.deleteMany({ announcement: id });
    await Announcement.deleteOne({ _id: id });
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark read
announcementRoutes.post("/:id/read", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

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
});

// Archive / Unarchive
announcementRoutes.post("/:id/archive", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
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
});

announcementRoutes.post("/:id/unarchive", authmiddleware, authorizedRole("admin", "teacher", "student"), async (req, res) => {
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
});

export default announcementRoutes;
