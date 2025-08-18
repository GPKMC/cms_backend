import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Each window is a single day with a time range in minutes since midnight.
 * Example: { day: 1, startMinutes: 360, endMinutes: 600 }  // Monday, 06:00–10:00
 */
const windowSchema = new Schema(
  {
    day: { type: Number, min: 0, max: 6, required: true }, // 0=Sun..6=Sat
    startMinutes: { type: Number, min: 0, max: 1439, required: true },
    endMinutes: { type: Number, min: 1, max: 1440, required: true },
  },
  { _id: false }
);

const teacherAvailabilitySchema = new Schema(
  {
    teacher: { type: Schema.Types.ObjectId, ref: "User", unique: true, required: true },
    weeklyWindows: { type: [windowSchema], default: [] },
    effectiveFrom: { type: Date },
    effectiveTo: { type: Date },
  },
  { timestamps: true }
);

// Basic window validity
teacherAvailabilitySchema.pre("validate", function (next) {
  for (const w of this.weeklyWindows) {
    if (w.startMinutes >= w.endMinutes) {
      return next(new Error("Availability window startMinutes must be < endMinutes"));
    }
  }
  next();
});

// Reject overlaps within the same day
teacherAvailabilitySchema
  .path("weeklyWindows")
  .validate(function (wins) {
    const byDay = new Map();
    for (const w of wins || []) {
      if (!byDay.has(w.day)) byDay.set(w.day, []);
      byDay.get(w.day).push({ s: w.startMinutes, e: w.endMinutes });
    }
    for (const [, list] of byDay) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++) {
        if (list[i - 1].e > list[i].s) return false;
      }
    }
    return true;
  }, "Overlapping availability windows in the same day");

// Keep a deterministic order
teacherAvailabilitySchema.pre("save", function (next) {
  if (Array.isArray(this.weeklyWindows)) {
    this.weeklyWindows.sort(
      (a, b) => a.day - b.day || a.startMinutes - b.startMinutes
    );
  }
  next();
});

const TeacherAvailability =
  models.TeacherAvailability || model("TeacherAvailability", teacherAvailabilitySchema);

export default TeacherAvailability;
