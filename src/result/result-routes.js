// routes/result-router.js
import express from "express";
import mongoose from "mongoose";
import InternalRecord from "../result/result-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import User from "../users/user-model.js"; // <-- students live in User with role: "student"
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

const ResultRouter = express.Router();

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers & Utilities
 * ────────────────────────────────────────────────────────────────────────── */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

function createHttp(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function ensureTeacherOwnsCI(ciId, teacherId) {
  const ci = await CourseInstance.findById(ciId).select("teacher").lean();
  if (!ci) throw createHttp(404, "CourseInstance not found");
  if (String(ci.teacher) !== String(teacherId)) throw createHttp(403, "Forbidden");
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const normalizeType = (type) =>
  type === "year" || type === "yearly" ? "yearly" : "semester";

function parseRequiredLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1) throw createHttp(400, "level is required and must be >=1");
  return n;
}

function parseRequiredExamSlot(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw createHttp(400, "examSlot (>=1) is required");
  return n;
}
function parseRequiredAttemptNo(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw createHttp(400, "attemptNo (>=1) is required");
  return n;
}
function parseOptionalExamSlot(v) {
  if (v == null) return undefined;
  return parseRequiredExamSlot(v);
}
function parseOptionalAttemptNo(v) {
  if (v == null) return undefined;
  return parseRequiredAttemptNo(v);
}
function parseBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).toLowerCase().trim();
  return ["1", "true", "yes", "y"].includes(s);
}

/** Reusable population for InternalRecord details */
function populateRecord(query) {
  return query
    .populate("student", "name username email")
    .populate({
      path: "courseInstance",
      select: "course batch teacher",
      populate: [
        {
          path: "course",
          select: "name code semesterOrYear",
          populate: { path: "semesterOrYear", select: "name semesterNumber yearNumber" },
        },
        { path: "batch", select: "batchname" },
        { path: "teacher", select: "name username email" },
      ],
    })
    .populate("filledBy", "name username email role")
    .populate("verifiedBy", "name username email role");
}

/** role-based allowed fields */
const TEACHER_CREATE_FIELDS_EXAM = [
  "kind", "courseInstance", "student",
  "examSlot", "attemptNo", "examTitle", "examDate",
  "maxMarks", "marks", "passMarks", "remarks", "examOutcome",
];
const TEACHER_CREATE_FIELDS_PRACT = [
  "kind", "courseInstance", "student",
  "pFirst", "pFinal", "pAssign", "pAttend",
  "practicalTotal", "passMarks", "remarks",
];
const TEACHER_PATCH_FIELDS_EXAM = [
  "examSlot", "attemptNo", "examTitle", "examDate",
  "maxMarks", "marks", "passMarks", "remarks", "examOutcome",
];
const TEACHER_PATCH_FIELDS_PRACT = [
  "pFirst", "pFinal", "pAssign", "pAttend",
  "practicalTotal", "passMarks", "remarks",
];

const ADMIN_CREATE_FIELDS_REGULAR = [
  ...TEACHER_CREATE_FIELDS_EXAM,
  ...TEACHER_CREATE_FIELDS_PRACT,
  "kind", "courseInstance", "student",
];
const ADMIN_PATCH_FIELDS = [
  // exam
  "examSlot","attemptNo","examTitle","examDate",
  "maxMarks","marks","passMarks","remarks","examOutcome",
  // practical
  "pFirst","pFinal","pAssign","pAttend","practicalTotal",
  // common
  "courseInstance","lockedByAdmin",
];

/** attach metadata flags */
function addFilledBy(doc, userId) { doc.filledBy = userId; }
function addVerifiedBy(update, adminId) { update.verifiedBy = adminId; }
function addSubmitFlags(update) {
  update.submittedForVerification = true;
  update.submittedAt = new Date();
}

/** get CIs in a batch for a given level & type */
async function getCIsForBatchLevel(batch, type, level, extraSelect = "") {
  const t = normalizeType(type);
  const lvl = parseRequiredLevel(level);

  const cis = await CourseInstance.find({ batch })
    .select(`course batch teacher ${extraSelect}`.trim())
    .populate({
      path: "course",
      select: "name code semesterOrYear",
      populate: { path: "semesterOrYear", select: "name semesterNumber yearNumber" },
    })
    .populate({ path: "batch", select: "batchname" })
    .populate({ path: "teacher", select: "name username email" })
    .lean();

  const filtered = cis.filter((ci) => {
    const meta = ci?.course?.semesterOrYear || {};
    const num = t === "yearly" ? meta.yearNumber : meta.semesterNumber;
    return Number(num) === lvl;
  });

  return { filtered, t, lvl };
}

/** get students by batch (User collection, role=student) */
async function getStudentsByBatch(batch) {
  return User.find({ batch, role: "student" })
    .select("_id name username email")
    .lean();
}

/* ──────────────────────────────────────────────────────────────────────────
 * TEACHER ROUTES
 * ────────────────────────────────────────────────────────────────────────── */

ResultRouter.use("/teacher", authmiddleware, authorizedRole("teacher"));

/**
 * POST /result/teacher/submit-bulk
 * Body: { courseInstance, kind? }
 * (Order before /teacher/:id to avoid path collision)
 */
ResultRouter.post("/teacher/submit-bulk", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { courseInstance, kind } = req.body || {};
    if (!isValidObjectId(courseInstance)) throw createHttp(400, "courseInstance required/invalid");
    await ensureTeacherOwnsCI(courseInstance, teacherId);

    const filter = {
      courseInstance,
      filledBy: teacherId,
      verifiedBy: null,
      lockedByAdmin: { $ne: true },
    };
    if (kind) filter.kind = kind;

    const update = {};
    addSubmitFlags(update);

    const { modifiedCount } = await InternalRecord.updateMany(filter, { $set: update });
    res.json({ ok: true, submittedCount: modifiedCount });
  } catch (err) { next(err); }
});

/**
 * GET /result/teacher
 * List records created by the teacher (within their CIs)
 */
ResultRouter.get("/teacher", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { courseInstance, student, kind, pending, examSlot, attemptNo } = req.query;

    const filter = { filledBy: teacherId };

    if (courseInstance) {
      if (!isValidObjectId(courseInstance)) throw createHttp(400, "Invalid courseInstance");
      await ensureTeacherOwnsCI(courseInstance, teacherId);
      filter.courseInstance = courseInstance;
    } else {
      const myCIs = await CourseInstance.find({ teacher: teacherId }).select("_id").lean();
      filter.courseInstance = { $in: myCIs.map((d) => d._id) };
    }

    if (student) {
      if (!isValidObjectId(student)) throw createHttp(400, "Invalid student");
      filter.student = student;
    }
    if (kind) filter.kind = kind;
    if (pending === "true") filter.verifiedBy = null;

    if (kind === "exam") {
      const slot = parseOptionalExamSlot(examSlot);
      const att  = parseOptionalAttemptNo(attemptNo);
      if (slot != null) filter.examSlot = slot;
      if (att != null)  filter.attemptNo = att;
    }

    const docs = await InternalRecord.find(filter)
      .populate("student", "name username email")
      .populate("courseInstance", "course batch")
      .lean();

    res.json({ ok: true, count: docs.length, data: docs });
  } catch (err) { next(err); }
});

/**
 * POST /result/teacher
 * Create exam/practical for your CI.
 */
ResultRouter.post("/teacher", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const body = req.body || {};

    if (!isValidObjectId(body.courseInstance)) throw createHttp(400, "courseInstance required/invalid");
    await ensureTeacherOwnsCI(body.courseInstance, teacherId);

    if (!isValidObjectId(body.student)) throw createHttp(400, "student required/invalid");
    if (!["exam", "practical"].includes(body.kind)) throw createHttp(400, "kind must be 'exam' or 'practical'");

    const allowed = body.kind === "exam" ? TEACHER_CREATE_FIELDS_EXAM : TEACHER_CREATE_FIELDS_PRACT;
    const payload = pick(body, allowed);
    addFilledBy(payload, teacherId);

    const created = await InternalRecord.create(payload);
    const populated = await populateRecord(InternalRecord.findById(created._id)).lean();
    res.status(201).json({ ok: true, data: populated });
  } catch (err) { next(err); }
});

/**
 * POST /result/teacher/:id/submit
 * Mark a single record as ready for verification.
 */
ResultRouter.post("/teacher/:id/submit", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");

    const doc = await InternalRecord.findById(id).populate("courseInstance", "teacher").lean();
    if (!doc) throw createHttp(404, "Not found");
    if (doc.lockedByAdmin) throw createHttp(409, "Record is locked by admin");
    await ensureTeacherOwnsCI(doc.courseInstance, teacherId);
    if (String(doc.filledBy) !== String(teacherId))
      throw createHttp(403, "You can only submit records you created");

    const update = {};
    addSubmitFlags(update);

    const updated = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, update, { new: true })
    ).lean();

    res.json({ ok: true, data: updated, message: "Submitted for admin verification." });
  } catch (err) { next(err); }
});

/**
 * PATCH /result/teacher/:id
 * Update your own record (not locked).
 */
ResultRouter.patch("/teacher/:id", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");

    const doc = await InternalRecord.findById(id).populate("courseInstance", "teacher").lean();
    if (!doc) throw createHttp(404, "Not found");
    if (doc.lockedByAdmin) throw createHttp(409, "Record is locked by admin");
    await ensureTeacherOwnsCI(doc.courseInstance, teacherId);
    if (String(doc.filledBy) !== String(teacherId))
      throw createHttp(403, "You can only modify records you created");

    const body = req.body || {};
    if (body.kind && body.kind !== doc.kind) throw createHttp(400, "Cannot change kind");
    if (body.courseInstance && String(body.courseInstance) !== String(doc.courseInstance._id))
      throw createHttp(400, "Cannot change courseInstance");
    if (body.student && String(body.student) !== String(doc.student))
      throw createHttp(400, "Cannot change student");

    const allowed = doc.kind === "exam" ? TEACHER_PATCH_FIELDS_EXAM : TEACHER_PATCH_FIELDS_PRACT;
    const update = pick(body, allowed);

    const updated = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, update, { new: true, runValidators: true })
    ).lean();
    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

/**
 * DELETE /result/teacher/:id
 */
ResultRouter.delete("/teacher/:id", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");

    const doc = await InternalRecord.findById(id).populate("courseInstance", "teacher").lean();
    if (!doc) throw createHttp(404, "Not found");
    if (doc.lockedByAdmin) throw createHttp(409, "Record is locked by admin");
    await ensureTeacherOwnsCI(doc.courseInstance, teacherId);
    if (String(doc.filledBy) !== String(teacherId))
      throw createHttp(403, "You can only delete records you created");

    await InternalRecord.findByIdAndDelete(id);
    res.json({ ok: true, deleted: id });
  } catch (err) { next(err); }
});

/**
 * GET /result/teacher/:id
 */
ResultRouter.get("/teacher/:id", async (req, res, next) => {
  try {
    const teacherId = req.user._id;
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");

    const doc = await InternalRecord.findById(id)
      .populate("student", "name username email")
      .populate("courseInstance", "teacher course batch")
      .lean();

    if (!doc) throw createHttp(404, "Not found");
    await ensureTeacherOwnsCI(doc.courseInstance, teacherId);
    if (String(doc.filledBy) !== String(teacherId))
      throw createHttp(403, "You can only access records you created");

    res.json({ ok: true, data: doc });
  } catch (err) { next(err); }
});

/* ---------- EXTRA: endpoints used by MarksEntry UI ---------- */

/**
 * GET /result/list/:ci
 */
ResultRouter.get(
  "/list/:ci",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res, next) => {
    try {
      const teacherId = req.user._id;
      const { ci } = req.params;
      if (!isValidObjectId(ci)) throw createHttp(400, "Invalid courseInstance");
      await ensureTeacherOwnsCI(ci, teacherId);

      const { kind, examSlot, attemptNo } = req.query;
      const filter = { courseInstance: ci };

      if (kind) filter.kind = kind;
      if (kind === "exam") {
        const slot = parseOptionalExamSlot(examSlot);
        const att  = parseOptionalAttemptNo(attemptNo);
        if (slot != null) filter.examSlot = slot;
        if (att != null)  filter.attemptNo = att;
      }

      const docs = await InternalRecord.find(filter)
        .populate("student", "name username email")
        .lean();

      res.json(docs);
    } catch (err) { next(err); }
  }
);

/**
 * POST /result/bulk/exam/:ci
 */
ResultRouter.post(
  "/bulk/exam/:ci",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res, next) => {
    try {
      const teacherId = req.user._id;
      const { ci } = req.params;
      if (!isValidObjectId(ci)) throw createHttp(400, "Invalid courseInstance");
      await ensureTeacherOwnsCI(ci, teacherId);

      const { examSlot, attemptNo, maxMarks, examTitle, rows } = req.body || {};
      const slot = parseRequiredExamSlot(examSlot);
      const att  = parseRequiredAttemptNo(attemptNo);
      const mm   = Number(maxMarks);
      if (!Number.isFinite(mm) || mm < 0) throw createHttp(400, "maxMarks (>=0) is required");
      if (!Array.isArray(rows) || rows.length === 0)
        return res.json({ ok: true, inserted: 0, updated: 0, skippedLocked: [] });

      const pass = Math.ceil(0.4 * mm);

      // Pre-fetch
      const studentIds = rows.filter(r => isValidObjectId(r.student)).map(r => r.student);
      const existing = await InternalRecord.find({
        courseInstance: ci,
        kind: "exam",
        examSlot: slot,
        attemptNo: att,
        student: { $in: studentIds },
      }).select("_id student lockedByAdmin filledBy").lean();

      const byStudent = new Map(existing.map(d => [String(d.student), d]));

      let inserted = 0, updated = 0;
      const skippedLocked = [];

      for (const r of rows) {
        const sid = String(r.student || "");
        if (!isValidObjectId(sid)) continue;

        const found = byStudent.get(sid);
        if (found?.lockedByAdmin) {
          skippedLocked.push(sid);
          continue;
        }

        const outcome = r.examOutcome || (r.marks != null ? "scored" : undefined);

        const query = found
          ? { _id: found._id }
          : {
              courseInstance: ci,
              student: sid,
              kind: "exam",
              examSlot: slot,
              attemptNo: att,
            };

        const update = {
          examTitle: examTitle ?? undefined,
          maxMarks: mm,
          passMarks: pass,
          remarks: r.remarks ?? undefined,
          examOutcome: outcome,
        };
        if ((outcome ?? "scored") === "scored") {
          update.marks = Number(r.marks);
        } else if (r.marks != null) {
          update.marks = Number(r.marks);
        }

        const opts = {
          new: true,
          upsert: !found,
          runValidators: true,
          setDefaultsOnInsert: true,
        };

        const wasExisting = !!found;
        await InternalRecord.findOneAndUpdate(
          query,
          { $set: update, ...(found ? {} : { $setOnInsert: { filledBy: teacherId } }) },
          opts
        );

        if (wasExisting) updated += 1;
        else inserted += 1;
      }

      res.json({ ok: true, inserted, updated, skippedLocked });
    } catch (err) { next(err); }
  }
);

/**
 * POST /result/bulk/practical/:ci
 */
ResultRouter.post(
  "/bulk/practical/:ci",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res, next) => {
    try {
      const teacherId = req.user._id;
      const { ci } = req.params;
      if (!isValidObjectId(ci)) throw createHttp(400, "Invalid courseInstance");
      await ensureTeacherOwnsCI(ci, teacherId);

      const {
        pMaxFirst = 0,
        pMaxFinal = 0,
        pMaxAssign = 0,
        pMaxAttend = 0,
        rows = [],
      } = req.body || {};

      if (!Array.isArray(rows) || rows.length === 0)
        return res.json({ ok: true, inserted: 0, updated: 0, skippedLocked: [] });

      const totalMax =
        Number(pMaxFirst) + Number(pMaxFinal) + Number(pMaxAssign) + Number(pMaxAttend);
      const pass = Math.ceil(0.4 * (Number.isFinite(totalMax) ? totalMax : 0));

      const studentIds = rows.filter(r => isValidObjectId(r.student)).map(r => r.student);
      const existing = await InternalRecord.find({
        courseInstance: ci,
        kind: "practical",
        student: { $in: studentIds },
      }).select("_id student lockedByAdmin filledBy").lean();

      const byStudent = new Map(existing.map(d => [String(d.student), d]));
      let inserted = 0, updated = 0;
      const skippedLocked = [];

      for (const r of rows) {
        const sid = String(r.student || "");
        if (!isValidObjectId(sid)) continue;

        const found = byStudent.get(sid);
        if (found?.lockedByAdmin) {
          skippedLocked.push(sid);
          continue;
        }

        const t =
          (Number(r.pFirst)  || 0) +
          (Number(r.pFinal)  || 0) +
          (Number(r.pAssign) || 0) +
          (Number(r.pAttend) || 0);

        const practicalTotal =
          Number.isFinite(Number(r.practicalTotal)) ? Number(r.practicalTotal) : t;

        const query = found ? { _id: found._id } : {
          courseInstance: ci,
          student: sid,
          kind: "practical",
        };

        const update = {
          pFirst:  r.pFirst  != null ? Number(r.pFirst)  : undefined,
          pFinal:  r.pFinal  != null ? Number(r.pFinal)  : undefined,
          pAssign: r.pAssign != null ? Number(r.pAssign) : undefined,
          pAttend: r.pAttend != null ? Number(r.pAttend) : undefined,
          practicalTotal: Number.isFinite(practicalTotal) ? practicalTotal : undefined,
          passMarks: pass,
          remarks: r.remarks ?? undefined,
        };

        const opts = {
          new: true,
          upsert: !found,
          runValidators: true,
          setDefaultsOnInsert: true,
        };

        const wasExisting = !!found;
        await InternalRecord.findOneAndUpdate(
          query,
          { $set: update, ...(found ? {} : { $setOnInsert: { filledBy: teacherId } }) },
          opts
        );

        if (wasExisting) updated += 1;
        else inserted += 1;
      }

      res.json({ ok: true, inserted, updated, skippedLocked });
    } catch (err) { next(err); }
  }
);

/* ──────────────────────────────────────────────────────────────────────────
 * ADMIN ROUTES
 * ────────────────────────────────────────────────────────────────────────── */

ResultRouter.use("/admin", authmiddleware, authorizedRole("admin"));

/**
 * GET /result/admin/list/:ci  (admin variant of list)
 */
ResultRouter.get("/admin/list/:ci", async (req, res, next) => {
  try {
    const { ci } = req.params;
    if (!isValidObjectId(ci)) throw createHttp(400, "Invalid courseInstance");

    const { kind, examSlot, attemptNo } = req.query;
    const filter = { courseInstance: ci };
    if (kind) filter.kind = kind;
    if (kind === "exam") {
      const slot = parseOptionalExamSlot(examSlot);
      const att  = parseOptionalAttemptNo(attemptNo);
      if (slot != null) filter.examSlot = slot;
      if (att != null)  filter.attemptNo = att;
    }

    const docs = await InternalRecord.find(filter)
      .populate("student", "name username email")
      .lean();

    res.json({ ok: true, count: docs.length, data: docs });
  } catch (err) { next(err); }
});

/**
 * GET /result/admin/by-scope
 * ?batch=<id>&type=semester|year|yearly&level=<n>
 * optional: kind=exam|practical&pending=true&examSlot=1&attemptNo=1&examTitle=Midterm
 */
ResultRouter.get("/admin/by-scope", async (req, res, next) => {
  try {
    const { batch, type, level, kind, pending, examSlot, attemptNo, examTitle } = req.query;

    if (!batch || !mongoose.Types.ObjectId.isValid(batch)) {
      throw createHttp(400, "batch is required/invalid");
    }

    const { filtered: filteredCIs, t, lvl } = await getCIsForBatchLevel(batch, type, level);

    const ciIds = filteredCIs.map((ci) => ci._id);
    if (ciIds.length === 0) {
      return res.json({ ok: true, count: 0, data: [], courseInstances: [], grouped: [] });
    }

    const rf = { courseInstance: { $in: ciIds } };
    if (kind) rf.kind = kind;
    if (pending === "true") rf.verifiedBy = null;

    if (!kind || kind === "exam") {
      const slot = parseOptionalExamSlot(examSlot);
      const att  = parseOptionalAttemptNo(attemptNo);
      if (slot != null) rf.examSlot = slot;
      if (att != null)  rf.attemptNo = att;
      if (examTitle) {
        rf.examTitle = { $regex: new RegExp(escapeRegExp(String(examTitle)), "i") };
      }
    }

    const docs = await InternalRecord.find(rf)
      .populate("student", "name username email")
      .populate({
        path: "courseInstance",
        select: "course batch teacher",
        populate: [
          { path: "course", select: "name code semesterOrYear",
            populate: { path: "semesterOrYear", select: "name semesterNumber yearNumber" } },
          { path: "batch", select: "batchname" },
          { path: "teacher", select: "name username email" },
        ],
      })
      .populate("filledBy", "name username email role")
      .populate("verifiedBy", "name username email role")
      .lean();

    // group records by CI for UI
    const byCI = {};
    for (const ci of filteredCIs) {
      byCI[String(ci._id)] = {
        ciId: ci._id,
        course: ci.course,
        batch: ci.batch,
        teacher: ci.teacher,
        records: [],
      };
    }
    for (const d of docs) {
      const k = String(d.courseInstance?._id || d.courseInstance);
      if (byCI[k]) byCI[k].records.push(d);
    }

    res.json({
      ok: true,
      count: docs.length,
      courseInstances: filteredCIs.map((ci) => ({
        _id: ci._id, course: ci.course, batch: ci.batch, teacher: ci.teacher,
      })),
      grouped: Object.values(byCI),
      data: docs,
      meta: { type: t, level: lvl },
    });
  } catch (err) { next(err); }
});

ResultRouter.get("/admin/exam-sessions/:ci", async (req, res, next) => {
  try {
    const { ci } = req.params;
    if (!mongoose.Types.ObjectId.isValid(ci)) throw createHttp(400, "Invalid courseInstance");

    const sessions = await InternalRecord.aggregate([
      { $match: { kind: "exam", courseInstance: new mongoose.Types.ObjectId(ci) } },
      {
        $group: {
          _id: { examSlot: "$examSlot", attemptNo: "$attemptNo", examTitle: "$examTitle" },
          count: { $sum: 1 },
          maxMarks: { $max: "$maxMarks" },
          passMarks: { $max: "$passMarks" },
          examDate: { $max: "$examDate" },
        },
      },
      {
        $project: {
          _id: 0,
          examSlot: "$_id.examSlot",
          examTitle: "$_id.examTitle",
          // Treat missing attempts as 1 for UI convenience
          attemptNo: { $ifNull: ["$_id.attemptNo", 1] },
          count: 1,
          maxMarks: 1,
          passMarks: 1,
          examDate: 1,
        },
      },
      { $sort: { examSlot: 1, attemptNo: 1, examTitle: 1 } },
    ]);

    res.json({ ok: true, sessions });
  } catch (err) { next(err); }
});



// ─────────────────────────────────────────────────────────────
// GET /result/admin/ledger
// Accepts EITHER examSlot OR examTitle (with attemptNo).
// - If examSlot is absent and examTitle is present, we derive the most
//   common slot for (title, attempt) across the scoped CIs.
// - When attemptNo === 1, we also include records where attemptNo is null/missing.
// ─────────────────────────────────────────────────────────────
ResultRouter.get("/admin/ledger", async (req, res, next) => {
  try {
    const {
      batch,
      type,
      level,
      examSlot,              // optional if examTitle provided
      attemptNo,             // required
      examTitle,             // optional; if provided allows auto slot
      requireVerified = "false",
    } = req.query;

    if (!batch || !mongoose.Types.ObjectId.isValid(batch))
      throw createHttp(400, "batch is required/invalid");

    // scope: CIs for the batch + level
    const { filtered: filteredCIs, t, lvl } = await getCIsForBatchLevel(batch, type, level);
    const ciIds = filteredCIs.map(ci => ci._id);
    if (ciIds.length === 0) {
      return res.json({ ok: true, columns: [], rows: [], courseInstances: [] });
    }

    const att = parseRequiredAttemptNo(attemptNo);
    const mustBeVerified = parseBool(requireVerified, false);

    // Decide slot:
    let slot;
    const hasTitle = !!examTitle && String(examTitle).trim() !== "";
    if (examSlot != null && String(examSlot).trim() !== "") {
      // explicit slot (By Slot mode)
      slot = parseRequiredExamSlot(examSlot);
    } else if (hasTitle) {
      // derive slot from (title, attempt) within scope (By Title mode)
      const titleRegex = new RegExp(escapeRegExp(String(examTitle)), "i");

      const matchAttempt =
        att === 1
          ? { $or: [{ attemptNo: att }, { attemptNo: null }] } // include missing attempts as 1
          : { attemptNo: att };

      const guess = await InternalRecord.aggregate([
        {
          $match: {
            kind: "exam",
            courseInstance: { $in: ciIds },
            examTitle: { $regex: titleRegex },
            ...matchAttempt,
          },
        },
        { $group: { _id: "$examSlot", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]);

      slot = guess?.[0]?._id;
      if (!Number.isInteger(slot)) {
        throw createHttp(404, "No matching exam session found for this examTitle & attempt");
      }
    } else {
      // neither slot nor title provided → keep old behavior (require slot)
      slot = parseRequiredExamSlot(examSlot);
    }

    // students
    let students = await getStudentsByBatch(batch);
    const studentIds = students.map(s => s._id);

    // Build base filter for records
    const attemptCond =
      att === 1
        ? { $or: [{ attemptNo: att }, { attemptNo: null }] }
        : { attemptNo: att };

    const base = {
      kind: "exam",
      courseInstance: { $in: ciIds },
      examSlot: slot,
      ...(mustBeVerified ? { verifiedBy: { $ne: null } } : {}),
      ...attemptCond, // top-level $or when att === 1
      ...(hasTitle ? { examTitle: { $regex: new RegExp(escapeRegExp(String(examTitle)), "i") } } : {}),
    };

    const recFilter = studentIds.length ? { ...base, student: { $in: studentIds } } : base;

    const recs = await InternalRecord.find(recFilter)
      .select(
        "student courseInstance examTitle maxMarks passMarks marks examOutcome verifiedBy lockedByAdmin remarks"
      )
      .lean();

    // Fallback: synthesize student list from records when User collection has none for batch
    if (students.length === 0 && recs.length > 0) {
      const uniq = new Map();
      for (const r of recs) {
        const id = String(r.student);
        if (!uniq.has(id)) uniq.set(id, { _id: r.student, name: undefined, username: undefined, email: undefined });
      }
      students = Array.from(uniq.values());
    }

    // Column meta per CI
    const metaByCI = new Map(filteredCIs.map(ci => [String(ci._id), {}]));
    for (const r of recs) {
      const k = String(r.courseInstance);
      const m = metaByCI.get(k) || {};
      if (r.examTitle != null && m.examTitle == null) m.examTitle = r.examTitle;
      if (r.maxMarks  != null && m.maxMarks  == null) m.maxMarks  = r.maxMarks;
      if (r.passMarks != null && m.passMarks == null) m.passMarks = r.passMarks;
      metaByCI.set(k, m);
    }

    const columns = filteredCIs.map(ci => {
      const cm = metaByCI.get(String(ci._id)) || {};
      return {
        ciId: String(ci._id),
        courseCode: ci.course?.code,
        courseName: ci.course?.name,
        teacher: ci.teacher,
        examTitle: cm.examTitle ?? (hasTitle ? String(examTitle) : null),
        maxMarks:  cm.maxMarks  ?? null,
        passMarks: cm.passMarks ?? null,
      };
    });

    // Index records (student,ci)
    const recMap = new Map();
    for (const r of recs) {
      recMap.set(`${String(r.student)}::${String(r.courseInstance)}`, r);
    }

    // Rows
    const rows = students.map(s => {
      const cells = {};
      for (const c of columns) {
        const key = `${String(s._id)}::${c.ciId}`;
        const r = recMap.get(key);
        const cm = metaByCI.get(c.ciId) || {};
        cells[c.ciId] = r
          ? {
              _id: r._id,
              examTitle: r.examTitle ?? (hasTitle ? String(examTitle) : null),
              maxMarks: r.maxMarks ?? null,
              passMarks: r.passMarks ?? null,
              marks: r.examOutcome === "scored" ? r.marks : null,
              examOutcome: r.examOutcome || "not_assigned",
              verified: !!r.verifiedBy,
              locked: !!r.lockedByAdmin,
              remarks: r.remarks ?? null,
            }
          : {
              _id: null,
              examTitle: cm.examTitle ?? (hasTitle ? String(examTitle) : null),
              maxMarks: cm.maxMarks ?? null,
              passMarks: cm.passMarks ?? null,
              marks: null,
              examOutcome: "not_assigned",
              verified: false,
              locked: false,
              remarks: null,
            };
      }
      return {
        student: { _id: s._id, name: s.name, username: s.username, email: s.email },
        cells,
      };
    });

    res.json({
      ok: true,
      meta: { batch, type: t, level: lvl, examSlot: slot, attemptNo: att, ...(hasTitle ? { examTitle } : {}) },
      courseInstances: filteredCIs.map(ci => ({ _id: ci._id, course: ci.course, teacher: ci.teacher })),
      columns,
      rows,
    });
  } catch (err) { next(err); }
});


/**
 * POST /result/admin/ledger-bulk
 * Body:
 * {
 *   batch, type, level, examSlot, attemptNo,
 *   updates: [{ student, courseInstance, examOutcome?, marks?, maxMarks?, passMarks?, examTitle?, remarks? }, ...]
 * }
 * - respects lockedByAdmin (skips)
 * - upserts exam records for that slot/attempt
 */
ResultRouter.post("/admin/ledger-bulk", async (req, res, next) => {
  try {
    const { batch, type, level, examSlot, attemptNo, updates = [] } = req.body || {};
    if (!batch || !mongoose.Types.ObjectId.isValid(batch)) throw createHttp(400, "batch is required/invalid");
    const t = normalizeType(type);
    const lvl = parseRequiredLevel(level);
    const slot = parseRequiredExamSlot(examSlot);
    const att  = parseRequiredAttemptNo(attemptNo);
    if (!Array.isArray(updates) || updates.length === 0)
      return res.json({ ok: true, upserted: 0, updated: 0, skippedLocked: [] });

    // allowed CI scope
    const cis = await CourseInstance.find({ batch })
      .select("course")
      .populate({ path: "course", select: "semesterOrYear",
        populate: { path: "semesterOrYear", select: "semesterNumber yearNumber" } })
      .lean();

    const allowedCI = new Set(
      cis
        .filter(ci => {
          const meta = ci?.course?.semesterOrYear || {};
          const num  = t === "yearly" ? meta.yearNumber : meta.semesterNumber;
          return Number(num) === lvl;
        })
        .map(ci => String(ci._id))
    );

    // prefetch existing
    const pairs = Array.from(new Set(
      updates
        .filter(u => isValidObjectId(u.student) && isValidObjectId(u.courseInstance) && allowedCI.has(String(u.courseInstance)))
        .map(u => `${u.student}::${u.courseInstance}`)
    ));
    const [studentIds, ciIds] = [new Set(), new Set()];
    for (const p of pairs) { const [s, c] = p.split("::"); studentIds.add(s); ciIds.add(c); }

    const existing = await InternalRecord.find({
      kind: "exam",
      student: { $in: Array.from(studentIds) },
      courseInstance: { $in: Array.from(ciIds) },
      examSlot: slot,
      attemptNo: att,
    }).select("_id student courseInstance lockedByAdmin").lean();

    const key = (s, c) => `${String(s)}::${String(c)}`;
    const byPair = new Map(existing.map(d => [key(d.student, d.courseInstance), d]));

    let upserted = 0, updated = 0;
    const skippedLocked = [];

    for (const u of updates) {
      if (!isValidObjectId(u.student) || !isValidObjectId(u.courseInstance)) continue;
      if (!allowedCI.has(String(u.courseInstance))) continue;

      const k = key(u.student, u.courseInstance);
      const found = byPair.get(k);

      if (found?.lockedByAdmin) {
        skippedLocked.push({ student: u.student, courseInstance: u.courseInstance });
        continue;
      }

      const outcome = u.examOutcome || (u.marks != null ? "scored" : undefined);

      const set = {
        ...(u.examTitle   != null ? { examTitle:   u.examTitle   || undefined } : {}),
        ...(u.maxMarks    != null ? { maxMarks:    Number(u.maxMarks) } : {}),
        ...(u.passMarks   != null ? { passMarks:   Number(u.passMarks) } : {}),
        ...(u.remarks     != null ? { remarks:     u.remarks     || undefined } : {}),
        ...(outcome       != null ? { examOutcome: outcome } : {}),
      };

      if ((outcome ?? "scored") === "scored") {
        if (u.marks == null) {
          if (!found) set.marks = 0; // model may require marks for 'scored'
        } else {
          set.marks = Number(u.marks);
        }
      } else {
        if (u.marks != null) set.marks = Number(u.marks);
      }

      if (found) {
        await InternalRecord.findByIdAndUpdate(found._id, { $set: set }, { new: false, runValidators: true });
        updated += 1;
      } else {
        await InternalRecord.create({
          kind: "exam",
          courseInstance: u.courseInstance,
          student: u.student,
          examSlot: slot,
          attemptNo: att,
          ...set,
          filledBy: req.user._id,
        });
        upserted += 1;
      }
    }

    res.json({ ok: true, upserted, updated, skippedLocked });
  } catch (err) { next(err); }
});

/**
 * GET /result/admin/final-summary
 * Rule:
 *   - consider only exam records where outcome = "scored" or "ab"
 *   - ignore "not_assigned"
 *   - FINAL = "Pass" if NO fails among counted; "Fail" otherwise; if none counted -> "NA"
 */
ResultRouter.get("/admin/final-summary", async (req, res, next) => {
  try {
    const { batch, type, level, examSlot, attemptNo } = req.query;
    if (!batch || !mongoose.Types.ObjectId.isValid(batch)) throw createHttp(400, "batch is required/invalid");

    const t = normalizeType(type);
    const lvl = parseRequiredLevel(level);
    const slot = parseRequiredExamSlot(examSlot);
    const att  = parseRequiredAttemptNo(attemptNo);

    // subjects (CIs)
    const cis = await CourseInstance.find({ batch })
      .select("course")
      .populate({
        path: "course",
        select: "semesterOrYear",
        populate: { path: "semesterOrYear", select: "semesterNumber yearNumber" }
      })
      .lean();

    const ciIds = cis
      .filter(ci => {
        const meta = ci?.course?.semesterOrYear || {};
        const num  = t === "yearly" ? meta.yearNumber : meta.semesterNumber;
        return Number(num) === lvl;
      })
      .map(ci => ci._id);

    // students
    const students = await getStudentsByBatch(batch);
    const studentIds = students.map(s => s._id);

    // recs for slot/attempt
    const recs = await InternalRecord.find({
      kind: "exam",
      courseInstance: { $in: ciIds },
      student: { $in: studentIds },
      examSlot: slot,
      attemptNo: att,
      examOutcome: { $in: ["scored", "ab"] }, // ignore not_assigned
    }).select("student courseInstance marks passMarks examOutcome").lean();

    // map student -> { counted, failed }
    const map = new Map(students.map(s => [String(s._id), { counted: 0, failed: 0 }]));
    for (const r of recs) {
      const sKey = String(r.student);
      const st = map.get(sKey);
      if (!st) continue;
      st.counted += 1;
      if (r.examOutcome === "ab") {
        st.failed += 1;
      } else {
        const m = Number(r.marks), p = Number(r.passMarks);
        if (Number.isFinite(m) && Number.isFinite(p) && m < p) st.failed += 1;
      }
    }

    const rows = students.map(s => {
      const st = map.get(String(s._id)) || { counted: 0, failed: 0 };
      const finalStatus = st.counted === 0 ? "NA" : (st.failed > 0 ? "Fail" : "Pass");
      return {
        student: { _id: s._id, name: s.name, username: s.username, email: s.email },
        countedSubjects: st.counted,
        failedSubjects: st.failed,
        finalStatus,
      };
    });

    res.json({
      ok: true,
      meta: { batch, type: t, level: lvl, examSlot: slot, attemptNo: att },
      rows,
    });
  } catch (err) { next(err); }
});

/**
 * GET /result/admin
 * generic search
 */
ResultRouter.get("/admin", async (req, res, next) => {
  try {
    const { pending, student, courseInstance, filledBy, kind, examSlot, attemptNo, examTitle } = req.query;

    const filter = {};
    if (pending === "true") filter.verifiedBy = null;

    if (student) {
      if (!isValidObjectId(student)) throw createHttp(400, "Invalid student");
      filter.student = student;
    }
    if (courseInstance) {
      if (!isValidObjectId(courseInstance)) throw createHttp(400, "Invalid courseInstance");
      filter.courseInstance = courseInstance;
    }
    if (filledBy) {
      if (!isValidObjectId(filledBy)) throw createHttp(400, "Invalid filledBy");
      filter.filledBy = filledBy;
    }
    if (kind) filter.kind = kind;

    if (!kind || kind === "exam") {
      const slot = parseOptionalExamSlot(examSlot);
      const att  = parseOptionalAttemptNo(attemptNo);
      if (slot != null) filter.examSlot = slot;
      if (att != null)  filter.attemptNo = att;
      if (examTitle) filter.examTitle = { $regex: new RegExp(escapeRegExp(String(examTitle)), "i") };
    }

    const docs = await InternalRecord.find(filter)
      .populate("student", "name username email")
      .populate("courseInstance", "course batch teacher")
      .populate("filledBy", "name username email role")
      .populate("verifiedBy", "name username email role")
      .lean();

    res.json({ ok: true, count: docs.length, data: docs });
  } catch (err) { next(err); }
});

/**
 * POST /result/admin
 */
ResultRouter.post("/admin", async (req, res, next) => {
  try {
    const body = pick(req.body || {}, ADMIN_CREATE_FIELDS_REGULAR);
    if (!isValidObjectId(body.courseInstance)) throw createHttp(400, "courseInstance required/invalid");
    if (!isValidObjectId(body.student)) throw createHttp(400, "student required/invalid");
    if (!["exam", "practical"].includes(body.kind)) throw createHttp(400, "kind must be 'exam' or 'practical'");
    addFilledBy(body, req.user._id);
    const created = await InternalRecord.create(body);
    const populated = await populateRecord(InternalRecord.findById(created._id)).lean();
    res.status(201).json({ ok: true, data: populated });
  } catch (err) { next(err); }
});

/** verify/unverify/lock/unlock BEFORE /admin/:id to avoid collision */
ResultRouter.post("/admin/:id/verify", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { lock = true } = req.body || {};
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const update = {};
    addVerifiedBy(update, req.user._id);
    if (lock) update.lockedByAdmin = true;
    const doc = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, update, { new: true })
    ).lean();
    if (!doc) throw createHttp(404, "Not found");
    res.json({ ok: true, data: doc, message: "Verified." });
  } catch (err) { next(err); }
});

ResultRouter.post("/admin/:id/unverify", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { unlock = false } = req.body || {};
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");

    const update = { verifiedBy: null };
    if (unlock) update.lockedByAdmin = false;

    const doc = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, update, { new: true })
    ).lean();
    if (!doc) throw createHttp(404, "Not found");
    res.json({ ok: true, data: doc, message: "Unverified." });
  } catch (err) { next(err); }
});

ResultRouter.post("/admin/:id/lock", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const doc = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, { lockedByAdmin: true }, { new: true })
    ).lean();
    if (!doc) throw createHttp(404, "Not found");
    res.json({ ok: true, data: doc, message: "Locked." });
  } catch (err) { next(err); }
});

ResultRouter.post("/admin/:id/unlock", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const doc = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, { lockedByAdmin: false }, { new: true })
    ).lean();
    if (!doc) throw createHttp(404, "Not found");
    res.json({ ok: true, data: doc, message: "Unlocked." });
  } catch (err) { next(err); }
});

/**
 * GET /result/admin/:id
 * (Placed AFTER all other /admin/* paths)
 */
ResultRouter.get("/admin/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const doc = await InternalRecord.findById(id)
      .populate("student", "name username email")
      .populate("courseInstance", "course batch teacher")
      .populate("filledBy", "name username email role")
      .populate("verifiedBy", "name username email role");
    if (!doc) throw createHttp(404, "Not found");
    res.json({ ok: true, data: doc });
  } catch (err) { next(err); }
});

/**
 * PATCH /result/admin/:id
 */
ResultRouter.patch("/admin/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const update = pick(req.body || {}, ADMIN_PATCH_FIELDS);
    const updated = await populateRecord(
      InternalRecord.findByIdAndUpdate(id, update, { new: true, runValidators: true })
    ).lean();
    if (!updated) throw createHttp(404, "Not found");
    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

/**
 * DELETE /result/admin/:id
 */
ResultRouter.delete("/admin/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw createHttp(400, "Invalid id");
    const deleted = await InternalRecord.findByIdAndDelete(id);
    if (!deleted) throw createHttp(404, "Not found");
    res.json({ ok: true, deleted: id });
  } catch (err) { next(err); }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Global error handler
 * ────────────────────────────────────────────────────────────────────────── */
ResultRouter.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || "Server error" });
});

export default ResultRouter;
