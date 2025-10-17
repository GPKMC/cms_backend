// src/schedule/schedule-routes.js
import express from "express";
import mongoose from "mongoose";
import ScheduleEvent from "./schedule-event-model.js";
import { authmiddleware, authorizedRole } from "../../users/user-middleware.js";

const teacherSchedule = express.Router();
const NEPAL_TZ = "Asia/Kathmandu";

/* ───────── helpers ───────── */
const ymdNepal = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: NEPAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // YYYY-MM-DD

const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const parseBool = (v) => String(v).toLowerCase() === "true";
const isObjId =
  (s) => mongoose.isValidObjectId?.(s) || mongoose.Types.ObjectId.isValid(s);

const addDaysNepal = (ymd, delta) => {
  const d = new Date(`${ymd}T00:00:00+05:45`);
  d.setDate(d.getDate() + delta);
  return ymdNepal(d);
};

const weekdayNameNepal = (ymd) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: NEPAL_TZ,
    weekday: "long",
  }).format(new Date(`${ymd}T12:00:00+05:45`)); // use noon for safety

/** Returns the Monday (Nepal-local) for the week containing ymd */
const mondayOfWeekNepal = (ymd) => {
  const d = new Date(`${ymd}T00:00:00+05:45`);
  const dow = d.getDay(); // 0..6 (Sun..Sat)
  const delta = (dow + 6) % 7; // steps to go back to Monday
  return addDaysNepal(ymd, -delta);
};

// Pull nice names safely from the populated graph or denormalized pointers
const pickSemLabel = (src) => {
  const val =
    src?.semester ||
    src?.sem ||
    src?.semesterNo ||
    src?.semesterOrYear?.name ||
    src?.year;
  if (typeof val === "number") return `Sem ${val}`;
  if (typeof val === "string" && val.trim()) return val.trim();
  return undefined;
};

const normalizeEvent = (raw) => {
  const ci = raw.courseInstance || {};
  const course = ci.course || raw.course || {};
  const batch = ci.batch || raw.batch || {};
  const faculty =
    course?.semesterOrYear?.faculty || raw.faculty || ci.faculty || {};

  return {
    ...raw,
    // convenience fields for the UI
    courseName: course.name || course.code || raw.courseName || "Class",
    batchId: batch?._id?.toString?.() || batch?.id,
    batchName: batch?.batchname || batch?.name,
    facultyId: faculty?._id?.toString?.() || faculty?.id,
    facultyName: faculty?.shortName || faculty?.name,
    semLabel:
      pickSemLabel(course) ||
      pickSemLabel(ci) ||
      pickSemLabel(batch),
  };
};

const summarize = (items) => {
  const bmap = new Map();
  const fmap = new Map();
  for (const ev of items) {
    if (ev.batchId && ev.batchName && !bmap.has(ev.batchId)) {
      bmap.set(ev.batchId, ev.batchName);
    }

    const fid =
      ev?.courseInstance?.course?.semesterOrYear?.faculty?._id?.toString?.() ||
      ev?.facultyId;
    const fname =
      ev?.courseInstance?.course?.semesterOrYear?.faculty?.shortName ||
      ev?.courseInstance?.course?.semesterOrYear?.faculty?.name ||
      ev?.facultyName;

    if (fid && fname && !fmap.has(fid)) {
      fmap.set(fid, fname);
    }
  }
  return {
    batches: Array.from(bmap, ([id, name]) => ({ id, name })),
    faculties: Array.from(fmap, ([id, name]) => ({ id, name })),
  };
};

/* ───────── Routes ───────── */

/**
 * GET /teacherSchedule/teacher/:teacherId/day?date=YYYY-MM-DD&includeCancelled=false
 */
teacherSchedule.get(
  "/teacher/:teacherId/day",
  authmiddleware,
  authorizedRole("teacher", "admin"), // allow admin to inspect specific teacher
  async (req, res) => {
    try {
      const { teacherId } = req.params;
      const { date: qDate, includeCancelled } = req.query;

      if (!teacherId)
        return res.status(400).json({ error: "teacherId is required" });

      const date = isYmd(qDate) ? qDate : ymdNepal();
      const teacher = isObjId(teacherId)
        ? new mongoose.Types.ObjectId(teacherId)
        : teacherId;

      const docs = await ScheduleEvent.findForTeacherOnDay({
        teacher,
        date,
        includeCancelled: parseBool(includeCancelled),
      });

      const items = docs.map(normalizeEvent);
      const summary = summarize(items);

      res.json({
        ok: true,
        date,
        tz: NEPAL_TZ,
        count: items.length,
        summary,
        items,
      });
    } catch (e) {
      console.error("GET /teacher/:teacherId/day error:", e);
      res
        .status(500)
        .json({ error: e.message || "Failed to fetch schedule" });
    }
  }
);

/**
 * GET /teacherSchedule/me/day?date=YYYY-MM-DD&includeCancelled=false
 */
teacherSchedule.get(
  "/me/day",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const uid = req.user?._id || req.user?.id;
      if (!uid) return res.status(401).json({ error: "Unauthenticated" });

      const { date: qDate, includeCancelled } = req.query;
      const date = isYmd(qDate) ? qDate : ymdNepal();

      const docs = await ScheduleEvent.findForTeacherOnDay({
        teacher: uid,
        date,
        includeCancelled: parseBool(includeCancelled),
      });

      const items = docs.map(normalizeEvent);
      const summary = summarize(items);

      res.json({
        ok: true,
        date,
        tz: NEPAL_TZ,
        count: items.length,
        summary,
        items,
      });
    } catch (e) {
      console.error("GET /me/day error:", e);
      res
        .status(500)
        .json({ error: e.message || "Failed to fetch schedule" });
    }
  }
);

/**
 * GET /teacherSchedule/me/week?start=YYYY-MM-DD&includeCancelled=false
 * Returns 7 Nepal-local days [Mon..Sun] for the week containing `start` (or today).
 */
teacherSchedule.get(
  "/me/week",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const uid = req.user?._id || req.user?.id;
      if (!uid) return res.status(401).json({ error: "Unauthenticated" });

      const startQuery = req.query.start;
      const includeCancelled = parseBool(req.query.includeCancelled);

      // If start not provided, use today; always snap to Monday (Nepal)
      const base = isYmd(startQuery) ? startQuery : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));

      const dayResults = await Promise.all(
        days.map((date) =>
          ScheduleEvent.findForTeacherOnDay({
            teacher: uid,
            date,
            includeCancelled,
          })
        )
      );

      const normalizedDays = dayResults.map((docs, i) => {
        const items = docs.map(normalizeEvent);
        return {
          date: days[i],
          weekday: weekdayNameNepal(days[i]),
          count: items.length,
          items,
        };
      });

      const flat = normalizedDays.flatMap((d) => d.items);
      const weeklySummary = summarize(flat);

      res.json({
        ok: true,
        tz: NEPAL_TZ,
        start: startYmd,
        end: days[6],
        days: normalizedDays,
        summary: weeklySummary,
      });
    } catch (e) {
      console.error("GET /me/week error:", e);
      res
        .status(500)
        .json({ error: e.message || "Failed to fetch weekly schedule" });
    }
  }
);

/**
 * GET /teacherSchedule/teacher/:teacherId/week?start=YYYY-MM-DD&includeCancelled=false
 * Admin (and teachers if you allow) can view any teacher’s week.
 */
teacherSchedule.get(
  "/teacher/:teacherId/week",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { teacherId } = req.params;
      if (!teacherId)
        return res.status(400).json({ error: "teacherId is required" });

      const teacher = isObjId(teacherId)
        ? new mongoose.Types.ObjectId(teacherId)
        : teacherId;

      const startQuery = req.query.start;
      const includeCancelled = parseBool(req.query.includeCancelled);

      const base = isYmd(startQuery) ? startQuery : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));

      const dayResults = await Promise.all(
        days.map((date) =>
          ScheduleEvent.findForTeacherOnDay({
            teacher,
            date,
            includeCancelled,
          })
        )
      );

      const normalizedDays = dayResults.map((docs, i) => {
        const items = docs.map(normalizeEvent);
        return {
          date: days[i],
          weekday: weekdayNameNepal(days[i]),
          count: items.length,
          items,
        };
      });

      const flat = normalizedDays.flatMap((d) => d.items);
      const weeklySummary = summarize(flat);

      res.json({
        ok: true,
        tz: NEPAL_TZ,
        teacherId: String(teacherId),
        start: startYmd,
        end: days[6],
        days: normalizedDays,
        summary: weeklySummary,
      });
    } catch (e) {
      console.error("GET /teacher/:teacherId/week error:", e);
      res
        .status(500)
        .json({ error: e.message || "Failed to fetch weekly schedule" });
    }
  }
);

export default teacherSchedule;
