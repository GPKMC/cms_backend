import express from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";

import Announcement, { ANNOUNCEMENT_TYPES } from "./announcement-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import AnnouncementState from "./announcement-state-model.js";
import AnnouncementReply from "./announcement-reply-model.js";

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
const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImage =
      file.mimetype?.startsWith("image/") || IMAGE_EXTS.has(ext);
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
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: n } }] },
    ],
  };
}

/** Handle ObjectId / string / populated object { _id: ... } */
function extractId(val) {
  if (!val) return null;

  if (val instanceof mongoose.Types.ObjectId) return val;

  if (typeof val === "string" && isId(val)) {
    return new mongoose.Types.ObjectId(val);
  }

  if (typeof val === "object" && val._id) {
    return extractId(val._id);
  }

  return null;
}

function collectBatchObjectIds(user) {
  const raw = new Set();

  const pushAny = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(pushAny);
      return;
    }
    const id = extractId(v);
    if (id) raw.add(String(id));
  };

  pushAny(user?.batch);
  pushAny(user?.batchId);
  pushAny(user?.batches);
  pushAny(user?.batchIds);
  pushAny(user?.profile?.batch);
  pushAny(user?.profile?.batches);

  return [...raw].map((idStr) => new mongoose.Types.ObjectId(idStr));
}

function collectFacultyObjectIds(user) {
  const raw = new Set();

  const pushAny = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(pushAny);
      return;
    }
    const id = extractId(v);
    if (id) raw.add(String(id));
  };

  // supports: faculty, facultyId, faculties[], facultyIds[], profile.faculty, profile.faculties
  pushAny(user?.faculty);
  pushAny(user?.facultyId);
  pushAny(user?.faculties);
  pushAny(user?.facultyIds);
  pushAny(user?.profile?.faculty);
  pushAny(user?.profile?.faculties);

  return [...raw].map((idStr) => new mongoose.Types.ObjectId(idStr));
}

/**
 * Which announcements this user is allowed to SEE.
 * UPDATED so that:
 *  - Students with known batchIds → strict match on audience.batchIds
 *  - Students without batchIds on req.user → still see all mode:"batches"
 */
function audienceFilter(user) {
  // Not logged in → only public/all announcements
  if (!user) {
    return {
      $or: [{ audience: { $exists: false } }, { "audience.mode": "all" }],
    };
  }

  // Admin → can see everything (subject to visibility())
  if (user.role === "admin") return {};

  const ors = [
    { audience: { $exists: false } }, // legacy docs
    { "audience.mode": "all" },       // everyone
  ];

  // ---------- Faculty-based visibility ----------
  const facultyOids = collectFacultyObjectIds(user);

  if (facultyOids.length) {
    // strict: only announcements whose facultyIds contain my faculty
    ors.push({
      "audience.mode": "faculty",
      "audience.facultyIds": { $in: facultyOids },
    });
  } else if (/teacher/i.test(user.role || "") || /student/i.test(user.role || "")) {
    // fallback: if we cannot detect any faculty for this user,
    // still allow them to see all faculty-mode announcements instead of hiding them all
    ors.push({
      "audience.mode": "faculty",
    });
  }

  // ---------- Batch-based visibility ----------
  // For students:
  //  - If we know their batch ObjectIds → filter by those
  //  - If we DON'T know their batch → show all batch-mode announcements
  if (/student/i.test(user.role || "")) {
    const batchOids = collectBatchObjectIds(user);

    if (batchOids.length) {
      ors.push({
        "audience.mode": "batches",
        "audience.batchIds": { $in: batchOids },
      });
    } else {
      // Fallback when req.user has no batch info (common when JWT payload is minimal).
      // Without this, all mode:"batches" announcements are invisible to students.
      ors.push({
        "audience.mode": "batches",
      });
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
  try {
    await fs.promises.unlink(p);
  } catch {
    /* ignore */
  }
}

function toDateOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function validateDates(
  publishAtRaw,
  expiresAtRaw,
  { checkPublishPast = true, checkExpiresPast = true } = {}
) {
  const publishAt = toDateOrNull(publishAtRaw);
  const expiresAt = toDateOrNull(expiresAtRaw);
  const nowTs = Date.now();

  if (checkPublishPast && publishAt && publishAt.getTime() < nowTs) {
    return "Publish date/time cannot be in the past.";
  }
  if (checkExpiresPast && expiresAt && expiresAt.getTime() < nowTs) {
    return "Expires date/time cannot be in the past.";
  }
  if (publishAt && expiresAt && expiresAt.getTime() < publishAt.getTime()) {
    return "Expires date/time cannot be earlier than the publish date/time.";
  }
  return null; // OK
}

/* ---- Create ---- */
announcementRoutes.post(
  "/",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const errMsg = validateDates(req.body.publishAt, req.body.expiresAt, {
        checkPublishPast: true,
        checkExpiresPast: true,
      });
      if (errMsg) return res.status(400).json({ error: errMsg });

      const doc = await Announcement.create({
        ...req.body,
        postedBy: req.user?._id,
      });
      res.status(201).json(doc);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

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

      // URL now starts with "/uploads/..." (relative),
      // not "http://localhost:5000/..." or Render URL
      const url = `/uploads/${relFromUploads.replace(/\\/g, "/")}`;

      return {
        url,
        originalname: f.originalname,
        filetype: f.mimetype,
        size: f.size,
      };
    });
    res.json({ files });
  }
);

// Multer error handler
announcementRoutes.use((err, req, res, next) => {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: err.message });
  next(err);
});

/* ---- List ---- */
announcementRoutes.get(
  "/",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { type, q } = req.query;
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.max(
        1,
        Math.min(100, Number(req.query.limit || 20))
      );
      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;

      const cond = {
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      };
      if (type && ANNOUNCEMENT_TYPES.includes(type))
        cond.type = type;
      if (q) cond.$text = { $search: String(q) };

      const [items, total] = await Promise.all([
        Announcement.find(cond)
          .sort({ pinned: -1, priority: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Announcement.countDocuments(cond),
      ]);

      const userId = req.user._id;
      const ids = items.map((i) => i._id);

      const states = await AnnouncementState.find({
        user: userId,
        announcement: { $in: ids },
      })
        .select("announcement readAt archived archivedAt")
        .lean();
      const stateMap = new Map(states.map((s) => [String(s.announcement), s]));

      // total replies
      const totalAgg = await AnnouncementReply.aggregate([
        {
          $match: {
            announcement: { $in: ids },
            isDeleted: { $ne: true },
          },
        },
        { $group: { _id: "$announcement", count: { $sum: 1 } } },
      ]);
      const totalMap = new Map(totalAgg.map((r) => [String(r._id), r.count]));

      // new replies
      const newAgg = await AnnouncementReply.aggregate([
        {
          $match: {
            announcement: { $in: ids },
            isDeleted: { $ne: true },
          },
        },
        {
          $lookup: {
            from: "announcementstates",
            let: { annId: "$announcement" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$announcement", "$$annId"] },
                      { $eq: ["$user", userId] },
                    ],
                  },
                },
              },
              { $project: { _id: 0, readAt: 1 } },
            ],
            as: "_state",
          },
        },
        {
          $addFields: {
            _readAt: { $ifNull: [{ $first: "$_state.readAt" }, null] },
          },
        },
        {
          $match: {
            $expr: {
              $or: [
                { $eq: ["$_readAt", null] },
                { $gt: ["$createdAt", "$_readAt"] },
              ],
            },
          },
        },
        { $group: { _id: "$announcement", count: { $sum: 1 } } },
      ]);
      const newMap = new Map(newAgg.map((r) => [String(r._id), r.count]));

      res.json({
        page,
        limit,
        total,
        data: items.map((i) => {
          const key = String(i._id);
          return {
            ...i,
            myState:
              stateMap.get(key) || {
                readAt: null,
                archived: false,
                archivedAt: null,
              },
            replyCount: totalMap.get(key) || 0,
            newReplyCount: newMap.get(key) || 0,
          };
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---- Folder counts ---- */
announcementRoutes.get(
  "/folder-counts",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const user = req.user;
      const userId = user?._id;
      const nowDate = new Date();

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
                      $and: [
                        { $ne: ["$published", false] },
                        { $ne: ["$publishAt", null] },
                        { $gt: ["$publishAt", nowDate] },
                      ],
                    },
                    then: "scheduled",
                  },
                  {
                    case: {
                      $and: [
                        { $ne: ["$published", false] },
                        { $ne: ["$expiresAt", null] },
                        { $lte: ["$expiresAt", nowDate] },
                      ],
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
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$announcement", "$$annId"] },
                      { $eq: ["$user", userId] },
                    ],
                  },
                },
              },
              { $project: { _id: 0, archived: 1 } },
            ],
            as: "_state",
          },
        },
        {
          $addFields: {
            _archived: {
              $ifNull: [{ $first: "$_state.archived" }, false],
            },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            drafts: {
              $sum: {
                $cond: [{ $eq: ["$_status", "draft"] }, 1, 0],
              },
            },
            scheduled: {
              $sum: {
                $cond: [{ $eq: ["$_status", "scheduled"] }, 1, 0],
              },
            },
            expired: {
              $sum: {
                $cond: [{ $eq: ["$_status", "expired"] }, 1, 0],
              },
            },
            live: {
              $sum: {
                $cond: [{ $eq: ["$_status", "live"] }, 1, 0],
              },
            },
            archived: {
              $sum: {
                $cond: [{ $eq: ["$_archived", true] }, 1, 0],
              },
            },
            inbox: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$_status", "live"] },
                      { $eq: ["$_archived", false] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            all: "$total",
            drafts: 1,
            scheduled: 1,
            expired: 1,
            live: 1,
            archived: 1,
            inbox: 1,
          },
        },
      ];

      const [row] = await Announcement.aggregate(pipeline);
      res.json(
        row || {
          all: 0,
          drafts: 0,
          scheduled: 0,
          expired: 0,
          live: 0,
          archived: 0,
          inbox: 0,
        }
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---- ID-scoped extras ---- */
announcementRoutes.get(
  "/:id/state",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
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

      const state = await AnnouncementState.findOne({
        user: req.user._id,
        announcement: id,
      })
        .select("readAt archived archivedAt")
        .lean();

      res.json(
        state || { readAt: null, archived: false, archivedAt: null }
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

announcementRoutes.get(
  "/:id/stats",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const exists = await Announcement.findOne({
        _id: id,
        isDeleted: false,
        ...audienceFilter(req.user),
      })
        .select("_id")
        .lean();
      if (!exists) return res.status(404).json({ error: "Not found" });

      const [agg] = await AnnouncementState.aggregate([
        { $match: { announcement: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: "$announcement",
            readCount: {
              $sum: {
                $cond: [{ $ifNull: ["$readAt", false] }, 1, 0],
              },
            },
            archivedCount: {
              $sum: {
                $cond: [{ $eq: ["$archived", true] }, 1, 0],
              },
            },
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
  }
);

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

      const cond = {
        _id: id,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      };
      const doc = await Announcement.findOne(cond).lean();
      if (!doc) return res.status(404).json({ error: "Not found" });

      const my = await AnnouncementState.findOne({
        user: req.user._id,
        announcement: id,
      })
        .select("readAt archived archivedAt")
        .lean();

      const [agg] = await AnnouncementState.aggregate([
        { $match: { announcement: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: "$announcement",
            readCount: {
              $sum: {
                $cond: [{ $ifNull: ["$readAt", false] }, 1, 0],
              },
            },
            archivedCount: {
              $sum: {
                $cond: [{ $eq: ["$archived", true] }, 1, 0],
              },
            },
          },
        },
      ]);

      res.json({
        ...doc,
        status: computeStatus(doc),
        myState:
          my || { readAt: null, archived: false, archivedAt: null },
        counts: {
          readCount: agg?.readCount || 0,
          archivedCount: agg?.archivedCount || 0,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---- Small dedicated reply counts endpoint ---- */
announcementRoutes.get(
  "/:id/reply-counts",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });

      const doc = await Announcement.findOne({
        _id: id,
        ...visibility({ adminIncludeUnpublished: req.user.role === "admin" }),
        ...audienceFilter(req.user),
      })
        .select("_id")
        .lean();
      if (!doc) return res.status(404).json({ error: "Not found" });

      const userId = req.user._id;

      const [totalRow] = await AnnouncementReply.aggregate([
        {
          $match: {
            announcement: doc._id,
            isDeleted: { $ne: true },
          },
        },
        { $group: { _id: "$announcement", count: { $sum: 1 } } },
      ]);

      const [newRow] = await AnnouncementReply.aggregate([
        {
          $match: {
            announcement: doc._id,
            isDeleted: { $ne: true },
          },
        },
        {
          $lookup: {
            from: "announcementstates",
            let: { annId: "$announcement" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$announcement", "$$annId"] },
                      { $eq: ["$user", userId] },
                    ],
                  },
                },
              },
              { $project: { _id: 0, readAt: 1 } },
            ],
            as: "_state",
          },
        },
        {
          $addFields: {
            _readAt: { $ifNull: [{ $first: "$_state.readAt" }, null] },
          },
        },
        {
          $match: {
            $expr: {
              $or: [
                { $eq: ["$_readAt", null] },
                { $gt: ["$createdAt", "$_readAt"] },
              ],
            },
          },
        },
        { $group: { _id: "$announcement", count: { $sum: 1 } } },
      ]);

      res.json({
        replyCount: totalRow?.count || 0,
        newReplyCount: newRow?.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---- CRUD + state ---- */
// Read single
announcementRoutes.get(
  "/:id",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: "Invalid id" });
      const isAdmin = req.user?.role === "admin";
      const adminView = isAdmin ? toBool(req.query.adminView, true) : false;
      const cond = {
        _id: id,
        ...visibility({ adminIncludeUnpublished: adminView }),
        ...audienceFilter(req.user),
      };

      const doc = await Announcement.findOne(cond).lean();
      if (!doc) return res.status(404).json({ error: "Not found" });

      const my = await AnnouncementState.findOne({
        user: req.user._id,
        announcement: id,
      })
        .select("readAt archived archivedAt")
        .lean();

      res.json({
        ...doc,
        myState:
          my || { readAt: null, archived: false, archivedAt: null },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Update
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
        "audience",
        "published",
        "publishAt",
        "expiresAt",
        "pinned",
        "priority",
      ];
      const update = {};
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];

      const current = await Announcement.findOne({
        _id: id,
        isDeleted: false,
      }).lean();
      if (!current) return res.status(404).json({ error: "Not found" });

      const nextPublished =
        typeof update.published === "boolean"
          ? update.published
          : !!current.published;

      let effPublishAt =
        update.publishAt != null
          ? new Date(update.publishAt)
          : current.publishAt
          ? new Date(current.publishAt)
          : null;

      let effExpiresAt =
        update.expiresAt != null
          ? new Date(update.expiresAt)
          : current.expiresAt
          ? new Date(current.expiresAt)
          : null;

      const nowDate = new Date();

      if (nextPublished && (!effPublishAt || isNaN(effPublishAt.getTime()))) {
        effPublishAt = nowDate;
        update.publishAt = effPublishAt;
      }

      if (effExpiresAt && effPublishAt && effExpiresAt <= effPublishAt) {
        return res
          .status(400)
          .json({ error: "Expiry date must be after the publish date." });
      }

      if (effExpiresAt && effExpiresAt <= nowDate) {
        return res
          .status(400)
          .json({ error: "Expiry date cannot be in the past." });
      }

      const doc = await Announcement.findOneAndUpdate(
        { _id: id, isDeleted: false },
        update,
        { new: true, runValidators: true }
      );

      res.json(doc);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// HARD delete
announcementRoutes.delete(
  "/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
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
  }
);

// Mark read
announcementRoutes.post(
  "/:id/read",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
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
  }
);

// Archive / Unarchive
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
