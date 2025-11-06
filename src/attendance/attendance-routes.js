// routes/attendanceRouter.js
import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

// ⬇️ Adjust these paths if your folders differ
import CourseInstance from "../course/courseinstance-model.js";
import AttendanceSession from "./attendanceSession-model.js";
import AttendanceRecord from "./attendanceRecord-model.js";
import User from "../users/user-model.js";

const AttendanceRouter = express.Router();

/* ------------------------- helpers ------------------------- */

function assertTeacherOwnsSessionOrElevated(user, sessionTeacherId) {
  if (user.role === "teacher" && String(sessionTeacherId) !== String(user._id)) {
    return false;
  }
  return true; // admin / superadmin pass
}

function utcMonthRange(year, month1to12) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0));
  const end   = new Date(Date.UTC(year, month1to12,     1, 0, 0, 0));
  return { start, end };
}

// 🔍 Normalize QR contents into a bare JWT (handles URL, JSON, Bearer, etc.)
function extractJwtToken(raw) {
  if (!raw) return null;
  let str = String(raw).trim();

  // Case 1: JSON string like {"token":"..."}
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === "object" && obj.token) {
      str = String(obj.token);
    }
  } catch {
    // not JSON, ignore
  }

  // Case 2: full URL with ?token=...
  try {
    if (str.startsWith("http://") || str.startsWith("https://")) {
      const url = new URL(str);
      const qToken = url.searchParams.get("token");
      if (qToken) str = qToken;
    }
  } catch {
    // not a valid URL, ignore
  }

  // Case 3: "Bearer <jwt>"
  str = str.replace(/^Bearer\s+/i, "");

  // Basic sanity check for JWT shape
  if (str.split(".").length !== 3) return null;

  return str;
}

/* ------------------------- open session ------------------------- */
/**
 * POST /attendance/sessions
 * Body: { courseInstanceId, rotating?: boolean }
 * Auth: teacher (owner of CI) | admin | superadmin
 */
/**
 * POST /attendance/sessions
 * Body:
 *   {
 *     courseInstanceId: string,
 *     rotating?: boolean,         // default true for live
 *     forDate?: "YYYY-MM-DD",     // optional: create/reuse a session on that date (UTC)
 *     reuse?: boolean             // default true: if a session exists that day, return it
 *   }
 */
AttendanceRouter.post(
  "/sessions",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      let { courseInstanceId, rotating = true, forDate, reuse = true } = req.body;

      const ci = await CourseInstance.findById(courseInstanceId).select("teacher");
      if (!ci) return res.status(404).json({ error: "CourseInstance not found" });

      if (req.user.role === "teacher" && String(ci.teacher) !== String(req.user._id)) {
        return res.status(403).json({ error: "Not the teacher of this course instance" });
      }

      // If forDate is provided, try to find/reuse a session on that day (UTC).
      if (forDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(forDate)) {
          return res.status(400).json({ error: 'forDate must be "YYYY-MM-DD"' });
        }
        const [y, m, d] = forDate.split("-").map(Number);
        const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
        const end   = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));

        if (reuse) {
          const existing = await AttendanceSession
            .findOne({ courseInstance: courseInstanceId, startedAt: { $gte: start, $lt: end } })
            .select("_id startedAt rotating isClosed");
          if (existing) {
            return res.json({
              sessionId: existing._id,
              startedAt: existing.startedAt,
              rotating: existing.rotating,
              reused: true
            });
          }
        }

        // Backfilled (historical) sessions usually don't need rotation
        if (req.body.rotating === undefined) rotating = false;

        const session = await AttendanceSession.create({
          courseInstance: courseInstanceId,
          teacher: req.user._id,
          rotating,
          sessionSecret: crypto.randomBytes(32).toString("hex"),
          startedAt: start,
        });

        // no realtime emit for historical, but harmless if you want:
        req.emitters?.sessionOpened?.(session);

        return res.json({
          sessionId: session._id,
          startedAt: session.startedAt,
          rotating: session.rotating,
          reused: false
        });
      }

      // normal "open now" flow
      const session = await AttendanceSession.create({
        courseInstance: courseInstanceId,
        teacher: req.user._id,
        rotating,
        sessionSecret: crypto.randomBytes(32).toString("hex"),
      });

      req.emitters?.sessionOpened?.(session);

      res.json({
        sessionId: session._id,
        startedAt: session.startedAt,
        rotating: session.rotating,
        reused: false
      });
    } catch (err) {
      console.error("open session error:", err);
      res.status(500).json({ error: "Failed to open attendance session" });
    }
  }
);


/* ------------------------- rotating token ------------------------- */
/**
 * GET /attendance/sessions/:id/token
 * Returns: { sessionId, token, exp }  // token ~20s
 * Auth: teacher (session owner) | admin | superadmin
 */
AttendanceRouter.get(
  "/sessions/:id/token",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const session = await AttendanceSession.findById(req.params.id);
      if (!session || session.isClosed) {
        return res.status(404).json({ error: "Invalid or closed session" });
      }

      if (!assertTeacherOwnsSessionOrElevated(req.user, session.teacher)) {
        return res.status(403).json({ error: "Not your session" });
      }

      const expiresInSeconds = 20; // UI refresh ~15s
      const token = jwt.sign(
        { sid: String(session._id), typ: "attendance" },
        session.sessionSecret,
        { expiresIn: expiresInSeconds }
      );
      const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

      res.json({ sessionId: session._id, token, exp });
    } catch (err) {
      console.error("token error:", err);
      res.status(500).json({ error: "Failed to issue rotating token" });
    }
  }
);

/* ------------------------- session meta ------------------------- */
/**
 * GET /attendance/sessions/:id/meta
 * Returns header info for the sheet (batch/course/etc)
 * Auth: teacher (session owner) | admin | superadmin
 */
AttendanceRouter.get(
  "/sessions/:id/meta",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const session = await AttendanceSession
        .findById(req.params.id)
        .select("startedAt teacher courseInstance isClosed");
      if (!session) return res.status(404).json({ error: "Session not found" });

      if (!assertTeacherOwnsSessionOrElevated(req.user, session.teacher)) {
        return res.status(403).json({ error: "Not your session" });
      }

      const ci = await CourseInstance.findById(session.courseInstance)
        .populate({ path: "batch",  select: "name title code" })
        .populate({ path: "course", select: "name title code shortName" })
        .lean();
      if (!ci) return res.status(404).json({ error: "CourseInstance not found" });

      const batchName =
        (ci.batch && (ci.batch.name || ci.batch.title || ci.batch.code)) || String(ci.batch || "");
      const courseName =
        (ci.course && (ci.course.name || ci.course.title || ci.course.shortName || ci.course.code)) ||
        String(ci.course || "");

      res.json({
        sessionId: String(session._id),
        startedAt: session.startedAt,
        isClosed: session.isClosed,
        courseInstanceId: String(session.courseInstance),
        batch:  { _id: String(ci.batch?._id || ci.batch || ""),  name: batchName },
        course: { _id: String(ci.course?._id || ci.course || ""), name: courseName },
      });
    } catch (err) {
      console.error("META route error:", err);
      res.status(500).json({ error: "Failed to load meta" });
    }
  }
);

/* ------------------------- close session (+ auto-absent) ------------------------- */
/**
 * POST /attendance/sessions/:id/close
 * Marks session closed and (optionally) auto-marks A for students without a record
 * Auth: teacher (session owner) | admin | superadmin
 */
AttendanceRouter.post(
  "/sessions/:id/close",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const session = await AttendanceSession.findById(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });

      if (!assertTeacherOwnsSessionOrElevated(req.user, session.teacher)) {
        return res.status(403).json({ error: "Not your session" });
      }

      if (!session.isClosed) {
        session.isClosed = true;
        session.closedAt = new Date();
        await session.save();

        // Auto-mark ABSENT for anyone in the batch who doesn't have a record yet
        try {
          const ci = await CourseInstance.findById(session.courseInstance).select("batch").lean();
          if (ci?.batch) {
            const students = await User.find({ role: "student", batch: ci.batch })
              .select("_id")
              .lean();

            const existing = await AttendanceRecord.find({ session: session._id })
              .select("student")
              .lean();
            const markedSet = new Set(existing.map(r => String(r.student)));

            const bulk = students
              .filter(s => !markedSet.has(String(s._id)))
              .map(s => ({
                updateOne: {
                  filter: { session: session._id, student: s._id },
                  update: {
                    $setOnInsert: {
                      session: session._id,
                      student: s._id,
                      via: "manual",
                    },
                    $set: { status: "absent", markedAt: new Date() }
                  },
                  upsert: true
                }
              }));
            if (bulk.length) {
              await AttendanceRecord.bulkWrite(bulk, { ordered: false });
            }
          }
        } catch (autoErr) {
          console.warn("auto-absent on close failed:", autoErr);
        }

        req.emitters?.sessionClosed?.(session._id);
      }

      res.json({ ok: true, closedAt: session.closedAt, alreadyClosed: !session.closedAt ? false : undefined });
    } catch (err) {
      console.error("close session error:", err);
      res.status(500).json({ error: "Failed to close session" });
    }
  }
);

/* ------------------------- students in session ------------------------- */
/**
 * GET /attendance/sessions/:id/students
 * Auth: teacher (session owner) | admin | superadmin
 */
AttendanceRouter.get(
  "/sessions/:id/students",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const session = await AttendanceSession
        .findById(req.params.id)
        .select("courseInstance teacher");
      if (!session) return res.status(404).json({ error: "Session not found" });

      if (!assertTeacherOwnsSessionOrElevated(req.user, session.teacher)) {
        return res.status(403).json({ error: "Not your session" });
      }

      const ci = await CourseInstance.findById(session.courseInstance).select("batch");
      if (!ci) return res.status(404).json({ error: "CourseInstance not found" });

      const students = await User.find({ role: "student", batch: ci.batch })
        .select("_id username email")
        .sort({ username: 1 });

      res.json({ students });
    } catch (err) {
      console.error("students route error:", err);
      res.status(500).json({ error: "Failed to fetch students" });
    }
  }
);

/* ------------------------- manual mark ------------------------- */
/**
 * POST /attendance/sessions/:id/manual
 * Body: { studentId, status: "present" | "absent" }
 * Auth: teacher (session owner) | admin | superadmin
 */
AttendanceRouter.post(
  "/sessions/:id/manual",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { studentId, status = "present" } = req.body;
      const allowed = new Set(["present", "absent"]);
      if (!allowed.has(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const session = await AttendanceSession.findById(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });

      if (!assertTeacherOwnsSessionOrElevated(req.user, session.teacher)) {
        return res.status(403).json({ error: "Not your session" });
      }

      const record = await AttendanceRecord.findOneAndUpdate(
        { session: session._id, student: studentId },
        { $set: { status, via: "manual", markedAt: new Date() } },
        { upsert: true, new: true }
      );

      req.emitters?.attendanceUpdated?.(session._id, record);

      res.json({ ok: true, record });
    } catch (err) {
      console.error("manual mark error:", err);
      res.status(500).json({ error: "Manual mark failed" });
    }
  }
);

/* ------------------------- student QR scan ------------------------- */
/**
 * POST /attendance/scan
 * Body: { token }  // rotating token from the QR (signed with session.sessionSecret)
 * Auth: student
 * Effect: Upsert record to { status: "present", via: "qr" }
 */
AttendanceRouter.post(
  "/scan",
  authmiddleware,
  authorizedRole("student"), // only students scan
  async (req, res) => {
    try {
      const raw = req.body.token;
      if (!raw) {
        return res.status(400).json({ error: "token required" });
      }

      // 🔍 Normalize whatever came from the QR to a bare JWT
      const token = extractJwtToken(raw);
      if (!token) {
        return res.status(400).json({ error: "invalid token" });
      }

      // Decode to get sid, then verify with per-session secret
      const decodedLoose = jwt.decode(token);
      const sid = decodedLoose?.sid;
      if (!sid) {
        return res.status(400).json({ error: "invalid token" });
      }

      const session = await AttendanceSession.findById(sid);
      if (!session || session.isClosed) {
        return res.status(404).json({ error: "Invalid or closed session" });
      }

      try {
        jwt.verify(token, session.sessionSecret); // throws if invalid/expired
      } catch {
        return res.status(401).json({ error: "token expired or invalid" });
      }

      // Optional: ensure student belongs to this CI's batch
      const ci = await CourseInstance.findById(session.courseInstance).select("batch");
      if (!ci) return res.status(404).json({ error: "CourseInstance not found" });

      const count = await User.countDocuments({
        _id: req.user._id,
        role: "student",
        batch: ci.batch,
      });

      if (!count) {
        return res.status(403).json({ error: "Not in this batch" });
      }

      const record = await AttendanceRecord.findOneAndUpdate(
        { session: session._id, student: req.user._id },
        { $set: { status: "present", via: "qr", markedAt: new Date() } },
        { upsert: true, new: true }
      );

      req.emitters?.attendanceUpdated?.(session._id, record);

      res.json({ ok: true, sessionId: String(session._id), record });
    } catch (err) {
      console.error("scan error:", err);
      res.status(500).json({ error: "Scan failed" });
    }
  }
);

/* ------------------------- month sheet report ------------------------- */
/**
 * GET /attendance/course-instances/:ciId/month?year=YYYY&month=1..12&includeStats=1
 * Auth: teacher (owner) | admin | superadmin
 *
 * Response:
 * {
 *   year, month, daysInMonth,
 *   students: [{_id, username, email}],
 *   sessionsByDay: {"1":"sessionId", "5":"sessionId", ...},
 *   matrix: { [studentId]: { 1: "present"|"absent"|"late"|null, ... } },
 *   stats?: {
 *     perStudent: { [studentId]: { present, absent, late, total, percentPresent } },
 *     perDay:     { [day]:       { present, absent, late, total } }
 *   }
 * }
 */
AttendanceRouter.get(
  "/course-instances/:ciId/month",
  authmiddleware,
  authorizedRole("teacher", "admin", "superadmin"),
  async (req, res) => {
    try {
      const { ciId } = req.params;
      const year = parseInt(req.query.year, 10);
      const month = parseInt(req.query.month, 10);
      const includeStats = String(req.query.includeStats || "") === "1";

      if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: "Provide ?year=YYYY&month=1..12" });
      }

      const ci = await CourseInstance.findById(ciId).select("teacher batch");
      if (!ci) return res.status(404).json({ error: "CourseInstance not found" });
      if (!assertTeacherOwnsSessionOrElevated(req.user, ci.teacher)) {
        return res.status(403).json({ error: "Not your course instance" });
      }

      const { start, end } = utcMonthRange(year, month);

      const sessions = await AttendanceSession
        .find({ courseInstance: ciId, startedAt: { $gte: start, $lt: end } })
        .select("_id startedAt")
        .lean();

      const sessionsByDay = {};
      for (const s of sessions) {
        const day = new Date(s.startedAt).getUTCDate();
        if (!sessionsByDay[day]) sessionsByDay[day] = String(s._id);
      }

      const sessionIds = sessions.map(s => s._id);
      const records = sessionIds.length
        ? await AttendanceRecord.find({ session: { $in: sessionIds } })
            .select("session student status")
            .lean()
        : [];

      const students = await User.find({ role: "student", batch: ci.batch })
        .select("_id username email")
        .sort({ username: 1 })
        .lean();

      const daysInMonth = new Date(year, month, 0).getDate();

      const matrix = {};
      for (const stu of students) {
        const row = {};
        for (let d = 1; d <= daysInMonth; d++) row[d] = null;
        matrix[String(stu._id)] = row;
      }

      const sessIdToDay = {};
      for (const [day, sid] of Object.entries(sessionsByDay)) {
        sessIdToDay[String(sid)] = parseInt(day, 10);
      }

      for (const rec of records) {
        const day = sessIdToDay[String(rec.session)];
        if (!day) continue;
        const sid = String(rec.student);
        if (matrix[sid]) matrix[sid][day] = rec.status; // "present" | "absent" | "late"
      }

      const payload = { year, month, daysInMonth, students, sessionsByDay, matrix };

      if (includeStats) {
        const perStudent = {};
        for (const stu of students) {
          const sid = String(stu._id);
          let present = 0, absent = 0, late = 0, total = 0;
          for (let d = 1; d <= daysInMonth; d++) {
            const v = matrix[sid][d];
            if (v) {
              total++;
              if (v === "present") present++;
              else if (v === "absent") absent++;
              else if (v === "late") late++;
            }
          }
          perStudent[sid] = {
            present, absent, late, total,
            percentPresent: total ? Math.round((present / total) * 100) : 0
          };
        }

        const perDay = {};
        for (let d = 1; d <= daysInMonth; d++) {
          if (!sessionsByDay[d]) continue;
          let present = 0, absent = 0, late = 0, total = 0;
          for (const stu of students) {
            const v = matrix[String(stu._id)][d];
            if (v) {
              total++;
              if (v === "present") present++;
              else if (v === "absent") absent++;
              else if (v === "late") late++;
            }
          }
          perDay[d] = { present, absent, late, total };
        }

        payload.stats = { perStudent, perDay };
      }

      res.json(payload);
    } catch (err) {
      console.error("month report error:", err);
      res.status(500).json({ error: "Failed to load month report" });
    }
  }
);

export default AttendanceRouter;
