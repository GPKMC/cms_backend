// models/schedule-event.model.js
import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

export const hhmmToMinutes = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
export const minutesToHHMM = (mins) => {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
};

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
    endDate:   { type: Date, required: true },

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
scheduleEventSchema.index({ courseInstance: 1, startDate: 1, endDate: 1 });

scheduleEventSchema.pre("validate", function (next) {
  if (this.startDate > this.endDate) return next(new Error("startDate cannot be after endDate"));
  if (this.startMinutes >= this.endMinutes) return next(new Error("startMinutes must be < endMinutes"));
  if (this.recurrence === "none") {
    const d = new Date(this.startDate).getDay();
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

    // Rebuild slug from current fields
    const d1 = new Date(this.startDate).toISOString().slice(0, 10);
    const d2 = new Date(this.endDate).toISOString().slice(0, 10);
    this.slug = `${this.courseInstance}-${this.recurrence}-${(this.daysOfWeek || []).join("")}-${d1}-${d2}-${this.startMinutes}-${this.endMinutes}`;

    // Pull & verify CourseInstance relations
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

    // BatchPeriod window check
    const BP = await mongoose
      .model("BatchPeriod")
      .findOne({ batch: this.batch, semesterOrYear: this.semesterOrYear, status: "ongoing" })
      .lean();
    if (!BP) return next(new Error("No ongoing BatchPeriod for this batch & semester/year"));
    if (BP.startDate && this.startDate < BP.startDate)
      return next(new Error("Event startDate before BatchPeriod.startDate"));
    if (BP.endDate && this.endDate > BP.endDate)
      return next(new Error("Event endDate after BatchPeriod.endDate"));

    // Teacher availability (time + effective date window)
    const TA = await mongoose.model("TeacherAvailability").findOne({ teacher: this.teacher }).lean();
    if (!TA || !Array.isArray(TA.weeklyWindows) || TA.weeklyWindows.length === 0) {
      return next(new Error("No availability defined for this teacher"));
    }
    // Effective date window (if provided on availability)
    if (TA.effectiveFrom && this.endDate < TA.effectiveFrom) {
      return next(new Error("Event outside teacher availability (before effectiveFrom)"));
    }
    if (TA.effectiveTo && this.startDate > TA.effectiveTo) {
      return next(new Error("Event outside teacher availability (after effectiveTo)"));
    }

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

    next();
  } catch (e) {
    next(e);
  }
});

const ScheduleEvent = models.ScheduleEvent || model("ScheduleEvent", scheduleEventSchema);
export default ScheduleEvent;
