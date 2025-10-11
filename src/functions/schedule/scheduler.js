// services/scheduler.js
import mongoose from "mongoose";
import ScheduleEvent from "./schedule-event.js";
import TeacherAvailability from "./teacher-availability.js";

const CI = () => mongoose.model("CourseInstance");
const BatchPeriod = () => mongoose.model("BatchPeriod");

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
const TIME_STEP = 30;

async function buildCandidates(task) {
  const ci = await CI()
    .findById(task.courseInstanceId)
    .populate({
      path: "course",
      populate: { path: "semesterOrYear", populate: { path: "faculty" } },
    })
    .populate("batch")
    .populate("teacher")
    .lean();

  if (!ci) throw new Error("CourseInstance not found");

  const bp = await BatchPeriod()
    .findOne({
      batch: ci.batch?._id,
      semesterOrYear: ci.course?.semesterOrYear?._id,
      status: "ongoing",
    })
    .lean();
  if (!bp) throw new Error("No ongoing BatchPeriod for this CourseInstance");

  const ta = await TeacherAvailability.findOne({
    teacher: ci.teacher?._id,
  }).lean();
  if (!ta || !ta.weeklyWindows?.length)
    throw new Error("Teacher has no availability");

  const allowedDaysSet = new Set(
    Array.isArray(task.allowedDays) && task.allowedDays.length
      ? task.allowedDays
      : ta.weeklyWindows.map((w) => w.day)
  );

  const candidates = [];
  for (const w of ta.weeklyWindows) {
    if (!allowedDaysSet.has(w.day)) continue;
    for (
      let s = w.startMinutes;
      s + task.durationMinutes <= w.endMinutes;
      s += TIME_STEP
    ) {
      const e = s + task.durationMinutes;
      candidates.push({ day: w.day, startMinutes: s, endMinutes: e });
    }
  }

  return {
    ci,
    bp,
    candidates,
    sessionsPerWeek: task.sessionsPerWeek,
    durationMinutes: task.durationMinutes,
    type: task.type || "lecture",
  };
}

/** busy map from existing events within the planning window */
async function buildExistingBusyMap({ startDate, endDate }) {
  const q = {
    isCancelled: { $ne: true },
    recurrence: "weekly",
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };

  // include courseInstance so we can forbid multiple same-CI sessions per day
  const existing = await ScheduleEvent.find(q)
    .select("courseInstance teacher batch daysOfWeek startMinutes endMinutes")
    .lean();

  const busy = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const e of existing) {
    for (const d of e.daysOfWeek || []) {
      busy[d].push({
        courseInstance: String(e.courseInstance),
        teacher: String(e.teacher),
        batch: String(e.batch),
        startMinutes: e.startMinutes,
        endMinutes: e.endMinutes,
      });
    }
  }
  return busy;
}

function clashes(placed, cand, busy) {
  // Block if the same CourseInstance is already scheduled that day
  for (const p of placed) {
    if (p.courseInstance === cand.courseInstance && p.day === cand.day)
      return true;

    // Original overlap rule (teacher OR batch cannot overlap in time on same day)
    if (
      p.day === cand.day &&
      overlap(p.startMinutes, p.endMinutes, cand.startMinutes, cand.endMinutes) &&
      (p.teacher === cand.teacher || p.batch === cand.batch)
    )
      return true;
  }

  const dayBusy = busy?.[cand.day] || [];
  for (const b of dayBusy) {
    // Also block if an existing saved event of the same CourseInstance already exists that day
    if (b.courseInstance === cand.courseInstance) return true;

    if (
      overlap(b.startMinutes, b.endMinutes, cand.startMinutes, cand.endMinutes) &&
      (b.teacher === cand.teacher || b.batch === cand.batch)
    )
      return true;
  }
  return false;
}

/** Simple forward check: ensure each remaining unit has at least one non-clashing candidate */
function forwardCheck(units, idx, placed, busy) {
  for (let i = idx + 1; i < units.length; i++) {
    const u = units[i];
    let ok = false;
    for (const c of u.candidates) {
      const cand = {
        courseInstance: u.ciId, // include CI so the same-day CI rule applies in lookahead
        teacher: u.teacher,
        batch: u.batch,
        day: c.day,
        startMinutes: c.startMinutes,
        endMinutes: c.endMinutes,
      };
      if (!clashes(placed, cand, busy)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

/** Backtracking weekly solver, with existing-events awareness + forward checking; transactional persist */
export async function solveWeeklyTimetable(tasks, opts = {}) {
  const { startDate: s, endDate: e, dryRun = false, checkExisting = true } = opts;
  if (!s || !e) throw new Error("startDate and endDate are required");
  const startDate = new Date(s);
  const endDate = new Date(e);

  const enriched = await Promise.all(tasks.map(buildCandidates));
  const byCi = new Map(enriched.map((x) => [x.ci._id.toString(), x]));

  const units = [];
  for (const x of enriched) {
    for (let i = 0; i < x.sessionsPerWeek; i++) {
      units.push({
        ciId: x.ci._id.toString(),
        teacher: x.ci.teacher._id.toString(),
        batch: x.ci.batch._id.toString(),
        semesterOrYear: x.ci.course.semesterOrYear._id.toString(),
        faculty: x.ci.course.semesterOrYear.faculty._id.toString(),
        type: x.type,
        candidates: x.candidates,
      });
    }
  }
  // most constrained first
  units.sort((a, b) => a.candidates.length - b.candidates.length);

  const busy = checkExisting ? await buildExistingBusyMap({ startDate, endDate }) : null;
  const placed = [];

  function backtrack(idx) {
    if (idx === units.length) return true;
    const u = units[idx];

    for (const c of u.candidates) {
      const cand = {
        courseInstance: u.ciId,
        teacher: u.teacher,
        batch: u.batch,
        semesterOrYear: u.semesterOrYear,
        faculty: u.faculty,
        day: c.day,
        startMinutes: c.startMinutes,
        endMinutes: c.endMinutes,
      };
      if (!clashes(placed, cand, busy)) {
        placed.push(cand);
        if (forwardCheck(units, idx, placed, busy) && backtrack(idx + 1)) return true;
        placed.pop();
      }
    }
    return false;
  }

  const ok = backtrack(0);
  if (!ok) throw new Error("No feasible timetable under current constraints");

  if (dryRun) {
    return placed.map((p) => ({
      ...p,
      recurrence: "weekly",
      daysOfWeek: [p.day],
      startDate,
      endDate,
    }));
  }

  // Persist in a single transaction
  const session = await mongoose.startSession();
  const results = [];
  try {
    await session.withTransaction(async () => {
      for (const p of placed) {
        const meta = byCi.get(p.courseInstance);
        const sDate =
          startDate ||
          (meta?.bp?.startDate ? new Date(meta.bp.startDate) : new Date());
        const eDate =
          endDate ||
          (meta?.bp?.endDate
            ? new Date(meta.bp.endDate)
            : new Date(sDate.getTime() + 90 * 24 * 3600 * 1000));

        // Include required denormalized fields before validation
        const event = new ScheduleEvent({
          courseInstance: p.courseInstance,
          teacher: p.teacher,
          batch: p.batch,
          semesterOrYear: p.semesterOrYear,
          faculty: p.faculty,

          type: "lecture",
          recurrence: "weekly",
          daysOfWeek: [p.day],
          startDate: sDate,
          endDate: eDate,
          startMinutes: p.startMinutes,
          endMinutes: p.endMinutes,
        });

        await event.save({ session });
        results.push(event);
      }
    });
  } finally {
    session.endSession();
  }

  return results;
}
