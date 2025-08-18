import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../../users/user-middleware.js";

// ⬇️ Adjust these two import paths if your folder layout differs
import TeacherAvailability from "./teacher-availability.js";
import ScheduleEvent from "./schedule-event.js";

const teacherAvailabilityRouter = express.Router();
const User = () => mongoose.model("User");

/* ----------------------------- helpers ----------------------------- */

function parseHHMM(str) {
  if (typeof str !== "string" || !/^\d{1,2}:\d{2}$/.test(str)) return NaN;
  const [h, m] = str.split(":").map(n => parseInt(n, 10));
  if (h < 0 || h > 23 || m < 0 || m > 59) return NaN;
  return h * 60 + m;
}

function coerceMinutes(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string") {
    // accept "540", "09:00"
    if (v.includes(":")) return parseHHMM(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Validate, sort, and de-overlap windows; throws on bad input. */
function normalizeWeeklyWindows(input) {
  const raw = Array.isArray(input) ? input : [];

  // Accept { day, startMinutes, endMinutes } or { day, start, end } (HH:MM or minutes)
  const wins = raw
    .map((w) => {
      const day = Number(w.day);
      const start =
        coerceMinutes(w.startMinutes ?? w.start ?? w.s);
      const end =
        coerceMinutes(w.endMinutes ?? w.end ?? w.e);
      return { day, startMinutes: start, endMinutes: end };
    })
    .filter(
      (w) =>
        Number.isInteger(w.day) &&
        w.day >= 0 &&
        w.day <= 6 &&
        Number.isFinite(w.startMinutes) &&
        Number.isFinite(w.endMinutes)
    )
    .map((w) => ({
      day: w.day,
      startMinutes: Math.max(0, Math.min(1439, w.startMinutes)),
      endMinutes: Math.max(1, Math.min(1440, w.endMinutes)),
    }));

  for (const w of wins) {
    if (w.startMinutes >= w.endMinutes) {
      throw new Error(
        `Invalid window: startMinutes must be < endMinutes (day=${w.day}, ${w.startMinutes}-${w.endMinutes})`
      );
    }
  }

  // group by day, sort, check overlaps
  const byDay = new Map();
  for (const w of wins) {
    if (!byDay.has(w.day)) byDay.set(w.day, []);
    byDay.get(w.day).push(w);
  }
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev.endMinutes > cur.startMinutes) {
        throw new Error(
          `Overlapping windows on day ${day} (${prev.startMinutes}-${prev.endMinutes} vs ${cur.startMinutes}-${cur.endMinutes})`
        );
      }
    }
  }

  // flatten back out (already sorted inside each day)
  return Array.from(byDay.values()).flat();
}

/* -------------------------------------------
 * GET /schedule/teachers   (admin)
 * Optional query: ?search=...&limit=50&page=1
 * ------------------------------------------- */
teacherAvailabilityRouter.get(
  "/teachers",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { search = "", limit = "50", page = "1" } = req.query;

      const q = { role: "teacher" };
      if (search && String(search).trim()) {
        const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rx = new RegExp(esc, "i");
        q.$or = [{ name: rx }, { email: rx }, { username: rx }];
      }

      const lim = Math.min(parseInt(limit, 10) || 50, 200);
      const pg = Math.max(parseInt(page, 10) || 1, 1);
      const skip = (pg - 1) * lim;

      const [users, total] = await Promise.all([
        User()
          .find(q)
          .select("_id name email username")
          .sort({ name: 1, email: 1 })
          .skip(skip)
          .limit(lim)
          .lean(),
        User().countDocuments(q),
      ]);

      res.json({ ok: true, users, total, page: pg, limit: lim });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* -------------------------------------------
 * GET /schedule/teachers/:id  (admin)
 * ------------------------------------------- */
teacherAvailabilityRouter.get(
  "/teachers/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const user = await User()
        .findOne({ _id: req.params.id, role: "teacher" })
        .select("_id name email username")
        .lean();
      if (!user) return res.status(404).json({ ok: false, error: "Teacher not found" });
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* -------------------------------------------
 * GET /schedule/teacher-availability/:teacherId (admin)
 * ------------------------------------------- */
teacherAvailabilityRouter.get(
  "/teacher-availability/:teacherId",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const ta = await TeacherAvailability.findOne({ teacher: req.params.teacherId }).lean();
      res.json({ ok: true, availability: ta || null });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* -------------------------------------------
 * PUT /schedule/teacher-availability/:teacherId (admin)
 * Validates teacher & windows, then upserts.
 * ------------------------------------------- */
teacherAvailabilityRouter.put(
  "/teacher-availability/:teacherId",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      // Must be an actual teacher
      const teacher = await User().findOne({ _id: req.params.teacherId, role: "teacher" }).lean();
      if (!teacher) return res.status(404).json({ ok: false, error: "Teacher not found" });

      // Normalize & validate windows
      let weeklyWindows = [];
      try {
        weeklyWindows = normalizeWeeklyWindows(req.body.weeklyWindows);
      } catch (e) {
        return res.status(400).json({ ok: false, error: e.message || "Invalid weeklyWindows" });
      }

      const { effectiveFrom, effectiveTo } = req.body;
      if (effectiveFrom && effectiveTo) {
        const from = new Date(effectiveFrom);
        const to = new Date(effectiveTo);
        if (from > to) {
          return res.status(400).json({ ok: false, error: "effectiveFrom cannot be after effectiveTo" });
        }
      }

      const update = {
        teacher: req.params.teacherId,
        weeklyWindows,
        ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}),
        ...(effectiveTo ? { effectiveTo: new Date(effectiveTo) } : {}),
      };

      const doc = await TeacherAvailability.findOneAndUpdate(
        { teacher: req.params.teacherId },
        update,
        { upsert: true, new: true, runValidators: true }
      );

      res.json({ ok: true, availability: doc });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* -------------------------------------------
 * GET /schedule/teacher-availability  (admin)
 * Paginated list of teachers with availability embedded
 * Query: ?search=&page=1&limit=50
 * ------------------------------------------- */
teacherAvailabilityRouter.get(
  "/teacher-availability",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { search = "", limit = "50", page = "1" } = req.query;

      const q = { role: "teacher" };
      if (String(search).trim()) {
        const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rx = new RegExp(esc, "i");
        q.$or = [{ name: rx }, { email: rx }, { username: rx }];
      }

      const lim = Math.min(parseInt(limit, 10) || 50, 200);
      const pg = Math.max(parseInt(page, 10) || 1, 1);
      const skip = (pg - 1) * lim;

      const [teachers, total] = await Promise.all([
        User()
          .find(q)
          .select("_id name email username")
          .sort({ name: 1, email: 1 })
          .skip(skip)
          .limit(lim)
          .lean(),
        User().countDocuments(q),
      ]);

      const ids = teachers.map((t) => t._id);
      const avDocs = await TeacherAvailability.find({ teacher: { $in: ids } }).lean();
      const avByTeacher = new Map(avDocs.map((a) => [String(a.teacher), a]));

      const rows = teachers.map((t) => ({
        ...t,
        availability: avByTeacher.get(String(t._id)) || null,
      }));

      res.json({ ok: true, rows, total, page: pg, limit: lim });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* -------------------------------------------
 * DELETE /schedule/teacher-availability/:teacherId (admin)
 * Optional query:
 *   also=events            -> also affect schedule events (default none)
 *   mode=cancel|delete     -> cancel (default) or hard-delete events
 *   from=YYYY-MM-DD        -> affect only events with endDate >= from (default today)
 * ------------------------------------------- */
teacherAvailabilityRouter.delete(
  "/teacher-availability/:teacherId",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    const { teacherId } = req.params;
    const { also = "none", mode = "cancel", from } = req.query;

    const affectEvents = String(also) === "events";
    const hardDelete = String(mode) === "delete";
    const fromDate = from ? new Date(String(from)) : new Date();

    const session = await mongoose.startSession();
    try {
      let deletedAvailability = null;
      let affectedEvents = 0;
      let eventAction = null;

      await session.withTransaction(async () => {
        // 1) Remove the availability doc (if any)
        deletedAvailability = await TeacherAvailability.findOneAndDelete(
          { teacher: teacherId },
          { session }
        );

        // 2) Optionally affect schedule events for this teacher (future or ongoing)
        if (affectEvents) {
          const eventFilter = {
            teacher: teacherId,
            endDate: { $gte: fromDate },
          };

          if (hardDelete) {
            const r = await ScheduleEvent.deleteMany(eventFilter, { session });
            affectedEvents = r.deletedCount || 0;
            eventAction = "deleted";
          } else {
            const r = await ScheduleEvent.updateMany(
              { ...eventFilter, isCancelled: { $ne: true } },
              { $set: { isCancelled: true } },
              { session }
            );
            affectedEvents = r.modifiedCount || r.nModified || 0;
            eventAction = "cancelled";
          }
        }
      });

      res.json({
        ok: true,
        deletedAvailability: Boolean(deletedAvailability),
        ...(affectEvents
          ? { eventAction, affectedEvents, from: fromDate.toISOString().slice(0, 10) }
          : {}),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      session.endSession();
    }
  }
);

export default teacherAvailabilityRouter;
