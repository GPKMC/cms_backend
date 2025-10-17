// routes/schedule-events.routes.js
import express from "express";
import mongoose from "mongoose";
import ScheduleEvent, { hhmmToMinutes } from "./schedule-event-model.js";
import { authmiddleware, authorizedRole } from "../../users/user-middleware.js";

const scheduleRouter = express.Router();

/* ---------- helpers ---------- */
function parseTimeToMinutes(v) {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.includes(":")) return hhmmToMinutes(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function normalizeDaysOfWeek(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return Array.from(
    new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))
  ).sort((a, b) => a - b);
}
function parseISODate(d) {
  if (!d) return undefined;
  const dt = new Date(d);
  return Number.isFinite(dt.valueOf()) ? dt : undefined;
}
function parseBool(x) {
  if (x === true || x === false) return x;
  if (x == null) return undefined;
  const s = String(x).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return undefined;
}

async function deriveDatesFromBatchPeriod(courseInstanceId) {
  const CI = await mongoose
    .model("CourseInstance")
    .findById(courseInstanceId)
    .populate({ path: "course", select: "semesterOrYear" })
    .populate({ path: "batch", select: "_id" })
    .lean();

  if (!CI) throw new Error("CourseInstance not found");
  const sy = CI.course?.semesterOrYear;
  const batch = CI.batch?._id || CI.batch;
  if (!sy || !batch) throw new Error("CI missing batch/semesterOrYear");

  const BP = await mongoose
    .model("BatchPeriod")
    .findOne({ batch, semesterOrYear: sy, status: "ongoing" })
    .lean();

  if (!BP || !BP.startDate || !BP.endDate) {
    throw new Error("No ongoing BatchPeriod with dates for this course instance");
  }
  return { start: new Date(BP.startDate), end: new Date(BP.endDate) };
}

/* ---------- list / filter (teacher sees own, student sees batch) ---------- */
scheduleRouter.get(
  "/schedule-events",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const {
        teacher,
        batch,
        courseInstance,
        semesterOrYear,
        faculty,
        day,
        from,
        to,
        includeCancelled,
      } = req.query;

      const q = {};
      if (req.user.role === "teacher") {
        q.teacher = req.user._id;
      } else if (teacher) {
        q.teacher = teacher;
      }

      if (req.user.role === "student") {
        if (req.user.batch) q.batch = req.user.batch;
      } else if (batch) {
        q.batch = batch;
      }

      if (courseInstance) q.courseInstance = courseInstance;
      if (semesterOrYear) q.semesterOrYear = semesterOrYear;
      if (faculty) q.faculty = faculty;

      if (day !== undefined && day !== "") {
        const d = Number(day);
        if (Number.isInteger(d) && d >= 0 && d <= 6) q.daysOfWeek = d;
      }

      const inc = parseBool(includeCancelled);
      if (inc !== true) q.isCancelled = { $ne: true };

      const fromDate = parseISODate(from);
      const toDate = parseISODate(to);
      if (fromDate || toDate) {
        if (toDate) q.startDate = { ...(q.startDate || {}), $lte: toDate };
        if (fromDate) q.endDate = { ...(q.endDate || {}), $gte: fromDate };
      }

      const events = await ScheduleEvent.find(q)
        .populate({
          path: "courseInstance",
          select: "course teacher batch",
          populate: [
            { path: "course", select: "name code" },
            { path: "teacher", select: "name username email" },
            { path: "batch", select: "batchname" },
          ],
        })
        .populate("teacher", "name username email")
        .populate("batch", "batchname")
        .populate("faculty", "name code")
        .populate("semesterOrYear", "name")
        .sort({ startDate: 1, daysOfWeek: 1, startMinutes: 1 })
        .lean();

      res.json({ ok: true, count: events.length, events });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- teacher/student convenience ---------- */
scheduleRouter.get(
  "/my/schedule",
  authmiddleware,
  authorizedRole("teacher", "student"),
  async (req, res) => {
    try {
      const q = { isCancelled: { $ne: true } };
      if (req.user.role === "teacher") q.teacher = req.user._id;
      if (req.user.role === "student" && req.user.batch) q.batch = req.user.batch;

      const events = await ScheduleEvent.find(q)
        .populate({
          path: "courseInstance",
          select: "course teacher batch",
          populate: [
            { path: "course", select: "name code" },
            { path: "teacher", select: "name username email" },
            { path: "batch", select: "batchname" },
          ],
        })
        .populate("teacher", "name username email")
        .populate("batch", "batchname")
        .populate("faculty", "name code")
        .populate("semesterOrYear", "name")
        .sort({ startDate: 1, daysOfWeek: 1, startMinutes: 1 })
        .lean();

      res.json({ ok: true, count: events.length, events });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- create (ADMIN) ---------- */
scheduleRouter.post(
  "/schedule-events",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const {
        courseInstance,
        type,
        recurrence = "weekly",
        daysOfWeek,
        startDate,
        endDate,
        startTime,
        endTime,
        notes,
      } = req.body;

      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = parseTimeToMinutes(endTime);
      if (startMinutes == null || endMinutes == null) {
        return res.status(400).json({ ok: false, error: "Invalid startTime/endTime" });
      }

      let start = parseISODate(startDate);
      let end = parseISODate(endDate ?? startDate);

      // Auto-derive from BatchPeriod if not provided
      if (!start || !end) {
        const derived = await deriveDatesFromBatchPeriod(courseInstance);
        start = derived.start;
        end = derived.end;
      }

      const normalizedDays = normalizeDaysOfWeek(daysOfWeek);
      if (recurrence === "weekly" && normalizedDays.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "daysOfWeek is required for weekly recurrence" });
      }

      const event = await ScheduleEvent.create({
        courseInstance,
        type: type || "lecture",
        recurrence,
        daysOfWeek: recurrence === "weekly" ? normalizedDays : undefined,
        startDate: start,
        endDate: end,
        startMinutes,
        endMinutes,
        notes,
      });

      res.json({ ok: true, event });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- update single (ADMIN) ---------- */
scheduleRouter.patch(
  "/schedule-events/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const e = await ScheduleEvent.findById(req.params.id);
      if (!e) return res.status(404).json({ ok: false, error: "Not found" });

      const {
        type,
        recurrence,
        daysOfWeek,
        startDate,
        endDate,
        startTime,
        endTime,
        notes,
        isCancelled,
      } = req.body;

      if (type) e.type = type;
      if (recurrence) e.recurrence = recurrence;

      if (daysOfWeek !== undefined) e.daysOfWeek = normalizeDaysOfWeek(daysOfWeek);

      if (startDate) {
        const d = parseISODate(startDate);
        if (!d) return res.status(400).json({ ok: false, error: "Invalid startDate" });
        e.startDate = d;
      }
      if (endDate) {
        const d = parseISODate(endDate);
        if (!d) return res.status(400).json({ ok: false, error: "Invalid endDate" });
        e.endDate = d;
      }

      if (startTime != null) {
        const m = parseTimeToMinutes(startTime);
        if (m == null) return res.status(400).json({ ok: false, error: "Invalid startTime" });
        e.startMinutes = m;
      }
      if (endTime != null) {
        const m = parseTimeToMinutes(endTime);
        if (m == null) return res.status(400).json({ ok: false, error: "Invalid endTime" });
        e.endMinutes = m;
      }

      if (notes !== undefined) e.notes = notes;
      if (isCancelled !== undefined) e.isCancelled = !!isCancelled;

      await e.save();
      res.json({ ok: true, event: e });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- cancel / un-cancel single (ADMIN) ---------- */
scheduleRouter.post(
  "/schedule-events/:id/cancel",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { cancel = true } = req.body || {};
      const e = await ScheduleEvent.findByIdAndUpdate(
        req.params.id,
        { $set: { isCancelled: !!cancel } },
        { new: true }
      );
      if (!e) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, event: e, action: cancel ? "cancelled" : "uncancelled" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- delete single (ADMIN) ---------- */
scheduleRouter.delete(
  "/schedule-events/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const e = await ScheduleEvent.findByIdAndDelete(req.params.id);
      if (!e) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, deleted: true, id: req.params.id });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- bulk cancel / delete (ADMIN)
   Query options:
     teacher=...
     batch=...
     courseInstance=...
     semesterOrYear=...
     faculty=...
     from=YYYY-MM-DD   (OPTIONAL) if provided, only affect events with endDate >= from
     mode=cancel|delete  (default cancel)
   Example:
     DELETE /schedule/schedule-events?batch=...&semesterOrYear=...&mode=delete
----------------------------------------------------------------------- */
scheduleRouter.delete(
  "/schedule-events",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { teacher, batch, courseInstance, semesterOrYear, faculty, from, mode = "cancel" } =
        req.query;

      // IMPORTANT: do NOT default to today. If "from" is omitted, affect ALL matching events.
      const fromDate = parseISODate(from);

      const q = {};
      if (fromDate) q.endDate = { $gte: fromDate };
      if (teacher) q.teacher = teacher;
      if (batch) q.batch = batch;
      if (courseInstance) q.courseInstance = courseInstance;
      if (semesterOrYear) q.semesterOrYear = semesterOrYear;
      if (faculty) q.faculty = faculty;

      if (mode === "delete") {
        const r = await ScheduleEvent.deleteMany(q);
        return res.json({
          ok: true,
          mode: "delete",
          deleted: r.deletedCount || 0,
          from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
        });
      }

      // default: cancel
      const r = await ScheduleEvent.updateMany(
        { ...q, isCancelled: { $ne: true } },
        { $set: { isCancelled: true } }
      );
      const modified = r.modifiedCount ?? r.nModified ?? 0;
      res.json({
        ok: true,
        mode: "cancel",
        cancelled: modified,
        from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- NEW: bulk UPDATE (toggle cancel / notes) over a scope (ADMIN) ---------- */
scheduleRouter.patch(
  "/schedule-events",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { teacher, batch, courseInstance, semesterOrYear, faculty, from } = req.query;
      const { isCancelled, notes } = req.body || {};

      if (typeof isCancelled === "undefined" && typeof notes === "undefined") {
        return res.status(400).json({ ok: false, error: "Nothing to update. Provide isCancelled and/or notes." });
      }

      const fromDate = parseISODate(from);

      const q = {};
      if (fromDate) q.endDate = { $gte: fromDate };
      if (teacher) q.teacher = teacher;
      if (batch) q.batch = batch;
      if (courseInstance) q.courseInstance = courseInstance;
      if (semesterOrYear) q.semesterOrYear = semesterOrYear;
      if (faculty) q.faculty = faculty;

      const set = {};
      if (typeof isCancelled !== "undefined") set.isCancelled = !!isCancelled;
      if (typeof notes !== "undefined") set.notes = notes;

      const r = await ScheduleEvent.updateMany(q, { $set: set });
      const modified = r.modifiedCount ?? r.nModified ?? 0;

      res.json({
        ok: true,
        updated: modified,
        from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- NEW: bulk UPDATE by courseInstance (ADMIN) ---------- */
scheduleRouter.patch(
  "/schedule-events/by-course/:courseInstanceId",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { courseInstanceId } = req.params;
      const { from } = req.query;
      const { isCancelled, notes } = req.body || {};

      if (!courseInstanceId) {
        return res.status(400).json({ ok: false, error: "courseInstanceId is required" });
      }
      if (typeof isCancelled === "undefined" && typeof notes === "undefined") {
        return res.status(400).json({ ok: false, error: "Nothing to update. Provide isCancelled and/or notes." });
      }

      const fromDate = parseISODate(from);
      const q = { courseInstance: courseInstanceId };
      if (fromDate) q.endDate = { $gte: fromDate };

      const set = {};
      if (typeof isCancelled !== "undefined") set.isCancelled = !!isCancelled;
      if (typeof notes !== "undefined") set.notes = notes;

      const r = await ScheduleEvent.updateMany(q, { $set: set });
      const modified = r.modifiedCount ?? r.nModified ?? 0;

      res.json({
        ok: true,
        courseInstance: courseInstanceId,
        updated: modified,
        from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ---------- reconcile (kept for future use; unchanged) ---------- */
const RELOCATE_STEP_MIN = 30;
function isCoveredByAvailability(windows, day, startMinutes, endMinutes) {
  return (windows || []).some(
    (w) => w.day === day && w.startMinutes <= startMinutes && w.endMinutes >= endMinutes
  );
}
async function tryRelocateEvent(e, weeklyWindows, { session, allowedDays }) {
  const duration = e.endMinutes - e.startMinutes;
  const baseDays =
    Array.isArray(e.daysOfWeek) && e.daysOfWeek.length
      ? e.daysOfWeek
      : [new Date(e.startDate).getDay()];
  const daysToTry =
    Array.isArray(allowedDays) && allowedDays.length ? allowedDays : baseDays;

  for (const day of daysToTry) {
    const wins = weeklyWindows.filter((w) => w.day === day);
    for (const w of wins) {
      for (let s = w.startMinutes; s + duration <= w.endMinutes; s += RELOCATE_STEP_MIN) {
        const candidate = { startMinutes: s, endMinutes: s + duration, day };
        const conflict = await ScheduleEvent.findConflict({
          _id: e._id,
          teacher: e.teacher,
          batch: e.batch,
          daysOfWeek: [day],
          startDate: e.startDate,
          endDate: e.endDate,
          startMinutes: candidate.startMinutes,
          endMinutes: candidate.endMinutes,
        });
        if (!conflict) return candidate;
      }
    }
  }
  return null;
}

scheduleRouter.post(
  "/schedule-events/reconcile",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const {
        teacherId,
        startDate,
        endDate,
        cancelIfUnplaceable = true,
        allowedDays,
        semesterOrYear,
        faculty,
        batch,
        courseInstance,
      } = req.body || {};

      if (!teacherId || !startDate || !endDate) {
        return res
          .status(400)
          .json({ ok: false, error: "teacherId, startDate, endDate are required" });
      }

      const TA = await mongoose.model("TeacherAvailability").findOne({ teacher: teacherId }).lean();
      if (!TA || !Array.isArray(TA.weeklyWindows) || TA.weeklyWindows.length === 0) {
        return res.status(400).json({ ok: false, error: "No availability defined for this teacher" });
      }

      const q = {
        teacher: teacherId,
        isCancelled: { $ne: true },
        recurrence: "weekly",
        startDate: { $lte: new Date(endDate) },
        endDate: { $gte: new Date(startDate) },
      };
      if (semesterOrYear) q.semesterOrYear = semesterOrYear;
      if (faculty) q.faculty = faculty;
      if (batch) q.batch = batch;
      if (courseInstance) q.courseInstance = courseInstance;

      const events = await ScheduleEvent.find(q).session(session);

      let kept = 0, moved = 0, cancelled = 0, unchanged = 0;

      await session.withTransaction(async () => {
        for (const e of events) {
          const days =
            Array.isArray(e.daysOfWeek) && e.daysOfWeek.length
              ? e.daysOfWeek
              : [new Date(e.startDate).getDay()];

          const allDaysCovered = days.every((d) =>
            isCoveredByAvailability(TA.weeklyWindows, d, e.startMinutes, e.endMinutes)
          );

          if (allDaysCovered) {
            kept++;
            continue;
          }

          const candidate = await tryRelocateEvent(e, TA.weeklyWindows, { session, allowedDays });
          if (candidate) {
            e.startMinutes = candidate.startMinutes;
            e.endMinutes = candidate.endMinutes;
            e.daysOfWeek = [candidate.day];
            await e.save({ session });
            moved++;
          } else if (cancelIfUnplaceable) {
            e.isCancelled = true;
            await e.save({ session });
            cancelled++;
          } else {
            unchanged++;
          }
        }
      });

      res.json({
        ok: true,
        teacherId,
        window: { startDate, endDate },
        scope: { semesterOrYear, faculty, batch, courseInstance },
        summary: { kept, moved, cancelled, unchanged, total: events.length },
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      session.endSession();
    }
  }
);

export default scheduleRouter;
