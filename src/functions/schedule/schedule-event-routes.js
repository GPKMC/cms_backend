// routes/schedule-events.routes.js
import express from "express";
import mongoose from "mongoose";
import ScheduleEvent, { hhmmToMinutes } from "./schedule-event.js";
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
  return Array.from(new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a,b)=>a-b);
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
  if (["1","true","yes","y","on"].includes(s)) return true;
  if (["0","false","no","n","off"].includes(s)) return false;
  return undefined;
}

async function deriveDatesFromBatchPeriod(courseInstanceId) {
  const CI = await mongoose.model("CourseInstance")
    .findById(courseInstanceId)
    .populate({ path: "course", select: "semesterOrYear" })
    .populate({ path: "batch", select: "_id" })
    .lean();

  if (!CI) throw new Error("CourseInstance not found");
  const sy = CI.course?.semesterOrYear;
  const batch = CI.batch?._id || CI.batch;
  if (!sy || !batch) throw new Error("CI missing batch/semesterOrYear");

  const BP = await mongoose.model("BatchPeriod")
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
        teacher, batch, courseInstance, semesterOrYear, faculty,
        day, from, to, includeCancelled,
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
        if (toDate)   q.startDate = { ...(q.startDate || {}), $lte: toDate };
        if (fromDate) q.endDate   = { ...(q.endDate   || {}), $gte: fromDate };
      }

      const events = await ScheduleEvent.find(q)
        .populate("courseInstance")
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
        .populate("courseInstance")
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
        courseInstance, type, recurrence = "weekly",
        daysOfWeek, startDate, endDate, startTime, endTime, notes,
      } = req.body;

      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = parseTimeToMinutes(endTime);
      if (startMinutes == null || endMinutes == null) {
        return res.status(400).json({ ok: false, error: "Invalid startTime/endTime" });
      }

      let start = parseISODate(startDate);
      let end   = parseISODate(endDate ?? startDate);

      // Auto-derive from BatchPeriod if not provided
      if (!start || !end) {
        const derived = await deriveDatesFromBatchPeriod(courseInstance);
        start = derived.start; end = derived.end;
      }

      const normalizedDays = normalizeDaysOfWeek(daysOfWeek);
      if (recurrence === "weekly" && normalizedDays.length === 0) {
        return res.status(400).json({ ok: false, error: "daysOfWeek is required for weekly recurrence" });
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

/* ---------- update (ADMIN) ---------- */
scheduleRouter.patch(
  "/schedule-events/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const e = await ScheduleEvent.findById(req.params.id);
      if (!e) return res.status(404).json({ ok: false, error: "Not found" });

      const {
        type, recurrence, daysOfWeek, startDate, endDate, startTime, endTime, notes, isCancelled,
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

export default scheduleRouter;
