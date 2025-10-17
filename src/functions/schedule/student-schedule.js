// src/schedule/student-schedule-routes.js
import express from "express";
import mongoose from "mongoose";
import ScheduleEvent from "./schedule-event-model.js";
import { authmiddleware, authorizedRole } from "../../users/user-middleware.js";
import User from "../../users/user-model.js"; // ✅ use User to resolve batch if needed

const studentSchedule = express.Router();
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
const isObjId = (s) => mongoose.isValidObjectId?.(s) || mongoose.Types.ObjectId.isValid(s);

const addDaysNepal = (ymd, delta) => {
  const d = new Date(`${ymd}T00:00:00+05:45`);
  d.setDate(d.getDate() + delta);
  return ymdNepal(d);
};

const weekdayNameNepal = (ymd) =>
  new Intl.DateTimeFormat("en-US", { timeZone: NEPAL_TZ, weekday: "long" })
    .format(new Date(`${ymd}T12:00:00+05:45`));

const mondayOfWeekNepal = (ymd) => {
  const d = new Date(`${ymd}T00:00:00+05:45`);
  const dow = d.getDay();            // 0..6
  const delta = (dow + 6) % 7;       // back to Monday
  return addDaysNepal(ymd, -delta);
};

// Pick a nice label for semester/year if different sources exist
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

// Normalize one event for the client
const normalizeEvent = (raw) => {
  const ci = raw.courseInstance || {};
  const course = ci.course || raw.course || {};
  const batch = ci.batch || raw.batch || {};
  const faculty =
    course?.semesterOrYear?.faculty ||
    raw.faculty ||
    ci.faculty ||
    {};
  const teacher = ci.teacher || raw.teacher || {};

  return {
    ...raw,

    courseName: course.name || course.code || raw.courseName || "Class",
    batchId: batch?._id?.toString?.() || batch?.id,
    batchName: batch?.batchname || batch?.name,
    facultyId: faculty?._id?.toString?.() || faculty?.id,
    facultyName: faculty?.shortName || faculty?.name,
    semLabel: pickSemLabel(course) || pickSemLabel(ci) || pickSemLabel(batch),

    teacherId: teacher?._id?.toString?.() || teacher?.id,
    teacherName: teacher?.name || teacher?.username || "",
  };
};

const summarize = (items) => {
  const courses = new Map();
  const teachers = new Map();
  const faculties = new Map();

  for (const ev of items) {
    const c = ev?.courseInstance?.course;
    if (c?._id || c?.name) {
      courses.set(c._id?.toString?.() || c.name, c.name || c.code || "Course");
    }

    const t = ev?.courseInstance?.teacher || ev?.teacher;
    if (t?._id || t?.name || t?.username) {
      teachers.set(t._id?.toString?.() || t.name || t.username, t.name || t.username);
    }

    const f = ev?.courseInstance?.course?.semesterOrYear?.faculty || ev?.faculty;
    if (f?._id || f?.name || f?.shortName) {
      faculties.set(f._id?.toString?.() || f.name || f.shortName, f.shortName || f.name);
    }
  }

  return {
    courses: Array.from(courses, ([id, name]) => ({ id, name })),
    teachers: Array.from(teachers, ([id, name]) => ({ id, name })),
    faculties: Array.from(faculties, ([id, name]) => ({ id, name })),
  };
};

/* ---------- ID guards ---------- */
const toObjectIdOrNull = (val) => {
  const str = typeof val === "string" ? val : null;
  return str && isObjId(str) ? new mongoose.Types.ObjectId(str) : null;
};
const pickId = (maybeDoc) =>
  maybeDoc?._id?.toString?.() || maybeDoc?.id || (typeof maybeDoc === "string" ? maybeDoc : null);

/** Resolve student's batch & semesterOrYear; can accept a concrete studentId */
const getStudentContext = async (req, explicitStudentId = null) => {
  const uid = req.user?._id || req.user?.id || null;

  // Prefer values already on the token, but only if they are valid ObjectIds.
  // IMPORTANT: if semesterOrYear is a number (e.g., 8), DO NOT pass it through.
  let batch = null;
  let semesterOrYear = null;

  // From token
  const tokenBatch = pickId(req.user?.batch ?? req.user?.batchId ?? req.user?.currentBatch);
  const tokenSem   = pickId(
    req.user?.semesterOrYear ??
    req.user?.semesterOrYearId ??
    req.user?.currentSemesterOrYear
  );

  // Guard them into ObjectIds
  if (tokenBatch && isObjId(tokenBatch)) batch = new mongoose.Types.ObjectId(tokenBatch);
  // Only keep semesterOrYear if it looks like a real ObjectId (not a number like "8")
  if (tokenSem && isObjId(tokenSem)) semesterOrYear = new mongoose.Types.ObjectId(tokenSem);

  // If explicit student id is provided OR we still don't have a batch, try resolving via User
  try {
    let userDoc = null;
    if (explicitStudentId) {
      const oid = isObjId(explicitStudentId)
        ? new mongoose.Types.ObjectId(explicitStudentId)
        : null;

      if (oid) {
        userDoc = await User.findById(oid).select("batch role").lean();
      }
    } else if (uid && !batch) {
      const oid = isObjId(uid) ? new mongoose.Types.ObjectId(uid) : null;
      if (oid) {
        userDoc = await User.findById(oid).select("batch role").lean();
      }
    }

    if (userDoc?.batch && isObjId(userDoc.batch)) {
      batch = new mongoose.Types.ObjectId(userDoc.batch);
    }
  } catch (e) {
    // ignore, we'll continue with what we have
  }

  // DO NOT pass numeric semester numbers to Mongoose filter.
  return { batch, semesterOrYear };
};

/* ───────── Routes ───────── */

/**
 * GET /studentSchedule/me/day?date=YYYY-MM-DD&includeCancelled=false
 * Uses the logged-in student's batch/semesterOrYear.
 */
studentSchedule.get(
  "/me/day",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { batch, semesterOrYear } = await getStudentContext(req);

      // At least one must be present. Since your User model requires batch for students,
      // this should usually pass. We DO NOT force semesterOrYear if it isn't a valid ObjectId.
      if (!batch && !semesterOrYear) {
        return res.status(400).json({ error: "No batch/semester found for this student" });
      }

      const date = isYmd(req.query.date) ? req.query.date : ymdNepal();
      const includeCancelled = parseBool(req.query.includeCancelled);

      // Build the filter object only with valid fields to avoid CastError
      const filter = { date, includeCancelled };
      if (batch) filter.batch = batch;
      if (semesterOrYear) filter.semesterOrYear = semesterOrYear;

      const docs = await ScheduleEvent.findForStudentOnDay(filter);

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
      console.error("GET /studentSchedule/me/day error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch student day schedule" });
    }
  }
);

/**
 * GET /studentSchedule/me/week?start=YYYY-MM-DD&includeCancelled=false
 * Returns 7 Nepal-local days [Mon..Sun] using student's batch/semesterOrYear.
 */
studentSchedule.get(
  "/me/week",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { batch, semesterOrYear } = await getStudentContext(req);
      if (!batch && !semesterOrYear) {
        return res.status(400).json({ error: "No batch/semester found for this student" });
      }

      const base = isYmd(req.query.start) ? req.query.start : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));
      const includeCancelled = parseBool(req.query.includeCancelled);

      const filterBase = {};
      if (batch) filterBase.batch = batch;
      if (semesterOrYear) filterBase.semesterOrYear = semesterOrYear;

      const dayResults = await Promise.all(
        days.map((date) =>
          ScheduleEvent.findForStudentOnDay({ ...filterBase, date, includeCancelled })
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
      console.error("GET /studentSchedule/me/week error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch student weekly schedule" });
    }
  }
);

/**
 * Admin/teacher views for a specific student
 * GET /studentSchedule/student/:studentId/day?date=YYYY-MM-DD&includeCancelled=false
 * GET /studentSchedule/student/:studentId/week?start=YYYY-MM-DD&includeCancelled=false
 */
studentSchedule.get(
  "/student/:studentId/day",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { batch, semesterOrYear } = await getStudentContext(req, studentId);
      if (!batch && !semesterOrYear) return res.status(400).json({ error: "No batch/semester for this student" });

      const date = isYmd(req.query.date) ? req.query.date : ymdNepal();
      const includeCancelled = parseBool(req.query.includeCancelled);

      const filter = { date, includeCancelled };
      if (batch) filter.batch = batch;
      if (semesterOrYear) filter.semesterOrYear = semesterOrYear;

      const docs = await ScheduleEvent.findForStudentOnDay(filter);

      const items = docs.map(normalizeEvent);
      res.json({
        ok: true,
        date,
        tz: NEPAL_TZ,
        count: items.length,
        items,
        summary: summarize(items),
      });
    } catch (e) {
      console.error("GET /studentSchedule/student/:studentId/day error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch student's day schedule" });
    }
  }
);

studentSchedule.get(
  "/student/:studentId/week",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { batch, semesterOrYear } = await getStudentContext(req, studentId);
      if (!batch && !semesterOrYear) return res.status(400).json({ error: "No batch/semester for this student" });

      const base = isYmd(req.query.start) ? req.query.start : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));
      const includeCancelled = parseBool(req.query.includeCancelled);

      const filterBase = {};
      if (batch) filterBase.batch = batch;
      if (semesterOrYear) filterBase.semesterOrYear = semesterOrYear;

      const dayResults = await Promise.all(
        days.map((date) =>
          ScheduleEvent.findForStudentOnDay({ ...filterBase, date, includeCancelled })
        )
      );

      const normalizedDays = dayResults.map((docs, i) => {
        const items = docs.map(normalizeEvent);
        return { date: days[i], weekday: weekdayNameNepal(days[i]), count: items.length, items };
      });

      const flat = normalizedDays.flatMap((d) => d.items);
      res.json({
        ok: true,
        tz: NEPAL_TZ,
        start: startYmd,
        end: days[6],
        days: normalizedDays,
        summary: summarize(flat),
      });
    } catch (e) {
      console.error("GET /studentSchedule/student/:studentId/week error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch student's weekly schedule" });
    }
  }
);

/**
 * Admin/teacher views by batch (day + week)
 * GET /studentSchedule/batch/:batchId/day?date=YYYY-MM-DD
 * GET /studentSchedule/batch/:batchId/week?start=YYYY-MM-DD
 */
studentSchedule.get(
  "/batch/:batchId/day",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      if (!batchId) return res.status(400).json({ error: "batchId is required" });

      const batch = isObjId(batchId) ? new mongoose.Types.ObjectId(batchId) : null;
      if (!batch) return res.status(400).json({ error: "batchId must be a valid ObjectId" });

      const date = isYmd(req.query.date) ? req.query.date : ymdNepal();
      const includeCancelled = parseBool(req.query.includeCancelled);

      const docs = await ScheduleEvent.findForStudentOnDay({ batch, date, includeCancelled });

      const items = docs.map(normalizeEvent);
      res.json({ ok: true, tz: NEPAL_TZ, date, count: items.length, items, summary: summarize(items) });
    } catch (e) {
      console.error("GET /studentSchedule/batch/:batchId/day error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch batch day schedule" });
    }
  }
);

studentSchedule.get(
  "/batch/:batchId/week",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      if (!batchId) return res.status(400).json({ error: "batchId is required" });

      const batch = isObjId(batchId) ? new mongoose.Types.ObjectId(batchId) : null;
      if (!batch) return res.status(400).json({ error: "batchId must be a valid ObjectId" });

      const base = isYmd(req.query.start) ? req.query.start : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));
      const includeCancelled = parseBool(req.query.includeCancelled);

      const dayResults = await Promise.all(
        days.map((date) => ScheduleEvent.findForStudentOnDay({ batch, date, includeCancelled }))
      );

      const normalizedDays = dayResults.map((docs, i) => {
        const items = docs.map(normalizeEvent);
        return { date: days[i], weekday: weekdayNameNepal(days[i]), count: items.length, items };
      });

      const flat = normalizedDays.flatMap((d) => d.items);
      res.json({
        ok: true,
        tz: NEPAL_TZ,
        start: startYmd,
        end: days[6],
        days: normalizedDays,
        summary: summarize(flat),
      });
    } catch (e) {
      console.error("GET /studentSchedule/batch/:batchId/week error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch batch weekly schedule" });
    }
  }
);

/**
 * Admin/teacher views by semesterOrYear (day + week)
 * GET /studentSchedule/semester/:semesterOrYearId/day
 * GET /studentSchedule/semester/:semesterOrYearId/week
 */
studentSchedule.get(
  "/semester/:semesterOrYearId/day",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { semesterOrYearId } = req.params;
      if (!semesterOrYearId) return res.status(400).json({ error: "semesterOrYearId is required" });

      const semesterOrYear = isObjId(semesterOrYearId)
        ? new mongoose.Types.ObjectId(semesterOrYearId)
        : null;
      if (!semesterOrYear) {
        return res.status(400).json({ error: "semesterOrYearId must be a valid ObjectId" });
      }

      const date = isYmd(req.query.date) ? req.query.date : ymdNepal();
      const includeCancelled = parseBool(req.query.includeCancelled);

      const docs = await ScheduleEvent.findForStudentOnDay({
        semesterOrYear,
        date,
        includeCancelled,
      });

      const items = docs.map(normalizeEvent);
      res.json({ ok: true, tz: NEPAL_TZ, date, count: items.length, items, summary: summarize(items) });
    } catch (e) {
      console.error("GET /studentSchedule/semester/:semesterOrYearId/day error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch semester/day schedule" });
    }
  }
);

studentSchedule.get(
  "/semester/:semesterOrYearId/week",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { semesterOrYearId } = req.params;
      if (!semesterOrYearId) return res.status(400).json({ error: "semesterOrYearId is required" });

      const semesterOrYear = isObjId(semesterOrYearId)
        ? new mongoose.Types.ObjectId(semesterOrYearId)
        : null;
      if (!semesterOrYear) {
        return res.status(400).json({ error: "semesterOrYearId must be a valid ObjectId" });
      }

      const base = isYmd(req.query.start) ? req.query.start : ymdNepal();
      const startYmd = mondayOfWeekNepal(base);
      const days = Array.from({ length: 7 }, (_, i) => addDaysNepal(startYmd, i));
      const includeCancelled = parseBool(req.query.includeCancelled);

      const dayResults = await Promise.all(
        days.map((date) =>
          ScheduleEvent.findForStudentOnDay({ semesterOrYear, date, includeCancelled })
        )
      );

      const normalizedDays = dayResults.map((docs, i) => {
        const items = docs.map(normalizeEvent);
        return { date: days[i], weekday: weekdayNameNepal(days[i]), count: items.length, items };
      });

      const flat = normalizedDays.flatMap((d) => d.items);
      res.json({
        ok: true,
        tz: NEPAL_TZ,
        start: startYmd,
        end: days[6],
        days: normalizedDays,
        summary: summarize(flat),
      });
    } catch (e) {
      console.error("GET /studentSchedule/semester/:semesterOrYearId/week error:", e);
      res.status(500).json({ error: e.message || "Failed to fetch semester/week schedule" });
    }
  }
);

export default studentSchedule;
