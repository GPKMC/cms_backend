// models/schedule-event.model.js
import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

/* ────────────────────────────────────────────────────────────────────────────
   Time helpers
   ──────────────────────────────────────────────────────────────────────────── */
const NEPAL_TZ = "Asia/Kathmandu";
const WEEKDAY_TO_INDEX = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

export const hhmmToMinutes = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
export const minutesToHHMM = (mins) => {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
};

/** Current minutes since midnight in Nepal time */
export const minutesNowInNepal = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: NEPAL_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hh * 60 + mm;
};

/**
 * Returns Nepal-local day boundaries (as Date objects representing absolute UTC instants)
 * and the Nepal-local day-of-week index (0=Sun ... 6=Sat) for a given YYYY-MM-DD.
 */
export const nepalDayRange = (yyyy_mm_dd) => {
  // Nepal-local midnight start & end as absolute instants
  const start = new Date(`${yyyy_mm_dd}T00:00:00.000+05:45`);
  const end = new Date(`${yyyy_mm_dd}T23:59:59.999+05:45`);

  // Resolve weekday name in Nepal TZ and map to 0..6
  const weekName = new Intl.DateTimeFormat("en-US", {
    timeZone: NEPAL_TZ,
    weekday: "long",
  }).format(new Date(`${yyyy_mm_dd}T12:00:00.000+05:45`)); // midday to stay safe
  const dow = WEEKDAY_TO_INDEX[weekName];

  return { start, end, dow };
};

/* ────────────────────────────────────────────────────────────────────────────
   Schema
   ──────────────────────────────────────────────────────────────────────────── */
const scheduleEventSchema = new Schema(
  {
    courseInstance: { type: Schema.Types.ObjectId, ref: "CourseInstance", required: true },

    // Denormalized pointers (autofilled from CourseInstance)
    teacher:        { type: Schema.Types.ObjectId, ref: "User", required: true },
    faculty:        { type: Schema.Types.ObjectId, ref: "Faculty", required: true },
    semesterOrYear: { type: Schema.Types.ObjectId, ref: "SemesterOrYear", required: true },
    batch:          { type: Schema.Types.ObjectId, ref: "Batch", required: true },

    type: { type: String, enum: ["lecture", "lab", "tutorial", "other"], default: "lecture" },

    recurrence: { type: String, enum: ["weekly", "none"], default: "weekly" },

    // Require array for weekly; validate 0..6
    daysOfWeek: {
      type: [Number],
      required: function () { return this.recurrence === "weekly"; },
      validate: {
        validator: function (v) {
          if (this.recurrence !== "weekly") return true;
          return Array.isArray(v) && v.length > 0 && v.every(n => Number.isInteger(n) && n >= 0 && n <= 6);
        },
        message: "daysOfWeek must be a non-empty array of integers 0..6 when recurrence is 'weekly'",
      },
    },

    startDate: { type: Date, required: true },

    // optional; we auto-fill/clamp in pre('save')
    endDate:   { type: Date },

    startMinutes: { type: Number, min: 0, max: 1439, required: true },
    endMinutes:   { type: Number, min: 1, max: 1440, required: true },

    notes: { type: String, trim: true },
    isCancelled: { type: Boolean, default: false },

    slug: { type: String, unique: true, index: true },
  },
  { timestamps: true }
);

/* Indexes */
scheduleEventSchema.index({
  teacher: 1, isCancelled: 1, daysOfWeek: 1, startDate: 1, endDate: 1, startMinutes: 1, endMinutes: 1,
});
scheduleEventSchema.index({
  batch: 1, daysOfWeek: 1, startDate: 1, endDate: 1, startMinutes: 1, endMinutes: 1,
});
scheduleEventSchema.index({
  semesterOrYear: 1, daysOfWeek: 1, startDate: 1, endDate: 1, startMinutes: 1, endMinutes: 1,
});
scheduleEventSchema.index({ courseInstance: 1, startDate: 1, endDate: 1 });

scheduleEventSchema.pre("validate", function (next) {
  // allow missing endDate here; it will be set/clamped in pre('save')
  if (this.endDate && this.startDate > this.endDate)
    return next(new Error("startDate cannot be after endDate"));
  if (this.startMinutes >= this.endMinutes)
    return next(new Error("startMinutes must be < endMinutes"));

  if (this.recurrence === "none") {
    const d = new Date(this.startDate).getDay(); // NOTE: server-local; use with care
    this.daysOfWeek = [d];
    this.endDate = this.endDate ?? this.startDate;
  }
  next();
});

scheduleEventSchema.statics.findConflict = async function ({
  _id, teacher, batch, daysOfWeek, startDate, endDate, startMinutes, endMinutes,
}) {
  const days = Array.isArray(daysOfWeek) ? daysOfWeek : [daysOfWeek].filter(v => v != null);
  const q = {
    isCancelled: { $ne: true },
    daysOfWeek: { $in: days },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
    startMinutes: { $lt: endMinutes },
    endMinutes: { $gt: startMinutes },
    $or: [{ teacher }, { batch }],
  };
  if (_id) q._id = { $ne: _id };
  return this.findOne(q).lean();
};

scheduleEventSchema.pre("save", async function (next) {
  try {
    // Normalize days for stable comparisons
    if (Array.isArray(this.daysOfWeek)) {
      this.daysOfWeek = Array.from(new Set(this.daysOfWeek.map(n => Number(n)))).sort((a,b)=>a-b);
    }

    // Pull & verify CourseInstance relations first (we need its graph to clamp endDate)
    const CI = await mongoose
      .model("CourseInstance")
      .findById(this.courseInstance)
      .populate({ path: "course", populate: { path: "semesterOrYear", populate: { path: "faculty" } } })
      .populate("batch")
      .populate("teacher");

    if (!CI) return next(new Error("CourseInstance not found"));

    // Teacher must match CourseInstance.teacher
    if (!CI.teacher?._id) return next(new Error("CourseInstance has no assigned teacher"));
    if (!this.teacher) this.teacher = CI.teacher._id;
    if (this.teacher.toString() !== CI.teacher._id.toString()) {
      return next(new Error("Teacher mismatch: schedule teacher must equal CourseInstance.teacher"));
    }

    // Denormalize
    this.batch = this.batch ?? CI.batch?._id;
    this.semesterOrYear = this.semesterOrYear ?? CI.course?.semesterOrYear?._id;
    this.faculty = this.faculty ?? CI.course?.semesterOrYear?.faculty?._id;

    if (!this.batch || !this.semesterOrYear || !this.faculty) {
      return next(new Error("Failed to derive batch/semesterOrYear/faculty from CourseInstance"));
    }

    // BatchPeriod window
    const BP = await mongoose
      .model("BatchPeriod")
      .findOne({ batch: this.batch, semesterOrYear: this.semesterOrYear, status: "ongoing" })
      .lean();
    if (!BP) return next(new Error("No ongoing BatchPeriod for this batch & semester/year"));

    // Teacher availability (time + effective date window)
    const TA = await mongoose.model("TeacherAvailability").findOne({ teacher: this.teacher }).lean();
    if (!TA || !Array.isArray(TA.weeklyWindows) || TA.weeklyWindows.length === 0) {
      return next(new Error("No availability defined for this teacher"));
    }

    // Effective date window logic
    // Allowed start must be >= BP.startDate and >= TA.effectiveFrom (if set)
    const minStart = [
      BP?.startDate ? +BP.startDate : null,
      TA?.effectiveFrom ? +TA.effectiveFrom : null,
    ].filter(v => v != null);
    const allowedStartMin = minStart.length ? new Date(Math.max(...minStart)) : null;

    if (allowedStartMin && this.startDate < allowedStartMin) {
      return next(new Error("Event startDate before allowed window (BatchPeriod/TeacherAvailability)"));
    }

    // Allowed end is <= BP.endDate and <= TA.effectiveTo (if set)
    const maxEnd = [
      BP?.endDate ? +BP.endDate : null,
      TA?.effectiveTo ? +TA.effectiveTo : null,
    ].filter(v => v != null);
    const allowedEndMax = maxEnd.length ? new Date(Math.min(...maxEnd)) : null;

    // Auto-fill / clamp endDate
    if (!this.endDate) {
      // if no endDate provided, extend to the maximum allowed window; fallback to startDate
      this.endDate = allowedEndMax || this.startDate;
    } else if (allowedEndMax && this.endDate > allowedEndMax) {
      this.endDate = allowedEndMax;
    }

    // Guard after clamp: startDate should not be after endDate
    if (this.startDate > this.endDate) {
      return next(new Error("startDate cannot be after endDate (after window clamping)"));
    }

    // Availability time windows (per weekday)
    const covers = (day, start, end) =>
      TA.weeklyWindows.some((w) => w.day === day && w.startMinutes <= start && w.endMinutes >= end);

    for (const d of this.daysOfWeek || []) {
      if (!covers(d, this.startMinutes, this.endMinutes)) {
        return next(new Error(`Teacher not available on day ${d} for ${this.startMinutes}-${this.endMinutes}`));
      }
    }

    // Final conflict check (teacher/batch)
    const conflict = await this.constructor.findConflict({
      _id: this._id,
      teacher: this.teacher,
      batch: this.batch,
      daysOfWeek: this.daysOfWeek,
      startDate: this.startDate,
      endDate: this.endDate,
      startMinutes: this.startMinutes,
      endMinutes: this.endMinutes,
    });
    if (conflict) {
      const who = conflict.teacher?.toString() === this.teacher.toString() ? "teacher" : "batch";
      return next(new Error(`Schedule conflict: overlapping ${who} booking with event ${conflict._id}`));
    }

    // Rebuild slug from current (possibly clamped) dates
    const d1 = new Date(this.startDate).toISOString().slice(0, 10);
    const d2 = new Date(this.endDate).toISOString().slice(0, 10);
    this.slug = `${this.courseInstance}-${this.recurrence}-${(this.daysOfWeek || []).join("")}-${d1}-${d2}-${this.startMinutes}-${this.endMinutes}`;

    next();
  } catch (e) {
    next(e);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   Query helpers
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Finds all events for a teacher on one Nepal-local calendar day.
 * @param {Object} opts
 * @param {string|ObjectId} opts.teacher
 * @param {string} opts.date - "YYYY-MM-DD" (Nepal-local)
 * @param {boolean} [opts.includeCancelled=false]
 * @returns {Promise<Array>}
 */
scheduleEventSchema.statics.findForTeacherOnDay = async function (opts = {}) {
  const { teacher, date, includeCancelled = false } = opts;
  if (!teacher) throw new Error("teacher is required");
  if (!date) throw new Error("date (YYYY-MM-DD) is required");

  const { start, end, dow } = nepalDayRange(date);

  const q = {
    teacher,
    daysOfWeek: dow,
    startDate: { $lte: end },
    endDate: { $gte: start },
  };
  if (!includeCancelled) q.isCancelled = { $ne: true };

  const docs = await this.find(q)
    .sort({ startMinutes: 1, endMinutes: 1 })
    .populate([
      {
        path: "courseInstance",
        populate: [
          {
            path: "course",
            select: "name code semesterOrYear",
            populate: {
              path: "semesterOrYear",
              select: "name faculty",
              populate: { path: "faculty", select: "name shortName code" },
            },
          },
          { path: "teacher", select: "name username email" },
          { path: "batch", select: "batchname" },
        ],
      },
      { path: "batch", select: "batchname" },
      { path: "faculty", select: "name shortName code" },
      { path: "semesterOrYear", select: "name" },
    ])
    .lean();

  const nowMins = minutesNowInNepal();

  return docs.map((ev) => {
    const startHHMM = minutesToHHMM(ev.startMinutes);
    const endHHMM = minutesToHHMM(ev.endMinutes);

    let status = "upcoming";
    if (nowMins >= ev.endMinutes) status = "past";
    else if (nowMins >= ev.startMinutes && nowMins < ev.endMinutes) status = "current";

    return {
      ...ev,
      occurrenceDate: date,
      dayOfWeek: dow,
      startTime: startHHMM,
      endTime: endHHMM,
      status, // "past" | "current" | "upcoming"
    };
  });
};

/**
 * Finds all events for a student (by batch and/or semesterOrYear) on one Nepal-local day.
 * @param {Object} opts
 * @param {string|ObjectId} [opts.batch]
 * @param {string|ObjectId} [opts.semesterOrYear]
 * @param {string} opts.date - "YYYY-MM-DD" (Nepal-local)
 * @param {boolean} [opts.includeCancelled=false]
 * @returns {Promise<Array>}
 */
scheduleEventSchema.statics.findForStudentOnDay = async function (opts = {}) {
  const { batch, semesterOrYear, date, includeCancelled = false } = opts;
  if (!date) throw new Error("date (YYYY-MM-DD) is required");
  if (!batch && !semesterOrYear) {
    throw new Error("batch or semesterOrYear is required");
  }

  const { start, end, dow } = nepalDayRange(date);

  const q = {
    daysOfWeek: dow,
    startDate: { $lte: end },
    endDate: { $gte: start },
  };
  if (batch) q.batch = batch;
  if (semesterOrYear) q.semesterOrYear = semesterOrYear;
  if (!includeCancelled) q.isCancelled = { $ne: true };

  const docs = await this.find(q)
    .sort({ startMinutes: 1, endMinutes: 1 })
    .populate([
      {
        path: "courseInstance",
        populate: [
          {
            path: "course",
            select: "name code semesterOrYear",
            populate: {
              path: "semesterOrYear",
              select: "name faculty",
              populate: { path: "faculty", select: "name shortName code" },
            },
          },
          { path: "teacher", select: "name username email" },
          { path: "batch", select: "batchname" },
        ],
      },
      { path: "batch", select: "batchname" },
      { path: "faculty", select: "name shortName code" },
      { path: "semesterOrYear", select: "name" },
    ])
    .lean();

  const nowMins = minutesNowInNepal();

  return docs.map((ev) => {
    const startHHMM = minutesToHHMM(ev.startMinutes);
    const endHHMM   = minutesToHHMM(ev.endMinutes);

    let status = "upcoming";
    if (nowMins >= ev.endMinutes) status = "past";
    else if (nowMins >= ev.startMinutes && nowMins < ev.endMinutes) status = "current";

    return {
      ...ev,
      occurrenceDate: date,
      dayOfWeek: dow,
      startTime: startHHMM,
      endTime: endHHMM,
      status,
    };
  });
};

const ScheduleEvent = models.ScheduleEvent || model("ScheduleEvent", scheduleEventSchema);
export default ScheduleEvent;
