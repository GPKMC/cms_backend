// routes/courseinstance-router.js
import express from "express";
import mongoose from "mongoose";
import Course from "../course/course-model.js";
import User from "../users/user-model.js";
import Batch from "../batch/batch-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";

const CourseInstancerouter = express.Router();

/* ------------------------------------------------------------------ */
/*  Common populate fragments (kept consistent across all endpoints)   */
/* ------------------------------------------------------------------ */
const POP_BATCH = { path: "batch", select: "batchname faculty" };
const POP_COURSE = {
  path: "course",
  select: "name code type semesterOrYear",
  populate: {
    path: "semesterOrYear",
    select: "name faculty",
    populate: { path: "faculty", select: "name code programLevel" },
  },
};
const POP_TEACHER = { path: "teacher", select: "_id username email role" };

/* ------------------------------- Helpers ------------------------------ */
async function validateInstance({ batch, course, teacher }) {
  const errors = [];
  if (!batch || !mongoose.Types.ObjectId.isValid(batch)) errors.push("Invalid batch");
  if (!course || !mongoose.Types.ObjectId.isValid(course)) errors.push("Invalid course");
  if (!teacher || !mongoose.Types.ObjectId.isValid(teacher)) {
    errors.push("Invalid teacher ID");
  } else {
    const t = await User.findById(teacher).select("role");
    if (!t || t.role !== "teacher") errors.push(`User ${teacher} is not a teacher`);
  }
  return { valid: errors.length === 0, errors };
}

/* -------------------------------- CREATE ------------------------------ */
CourseInstancerouter.post(
  "/courseInstance",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { batch, course, teacher, materials, assignments, attendanceRecords, grades } = req.body;

      const { valid, errors } = await validateInstance({ batch, course, teacher });
      if (!valid) return res.status(400).json({ errors });

      const exists = await CourseInstance.findOne({ batch, course }).lean();
      if (exists)
        return res
          .status(400)
          .json({ error: "Instance already exists for this batch and course." });

      // Enforce isActive rule based on Course.type
      const courseDoc = await Course.findById(course).select("type");
      if (!courseDoc) return res.status(404).json({ error: "Related course not found." });

      let isActive = false;
      if (courseDoc.type === "compulsory") isActive = true;
      else if (courseDoc.type === "elective")
        isActive = typeof req.body.isActive !== "undefined" ? !!req.body.isActive : false;

      const ci = await CourseInstance.create({
        batch,
        course,
        teacher,
        materials,
        assignments,
        attendanceRecords,
        grades,
        isActive,
      });

      const populated = await CourseInstance.findById(ci._id)
        .populate(POP_BATCH)
        .populate(POP_COURSE)
        .populate(POP_TEACHER)
        .lean();

      res.status(201).json({ message: "Created", instance: populated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* --------------------------------- LIST ------------------------------- */
CourseInstancerouter.get(
  "/courseInstance",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    try {
      const { batch, course, teacher } = req.query;
      const hideOrphans = !["0", "false", "no", "off"].includes(
        String(req.query.hideOrphans || "1").toLowerCase()
      );

      const q = {};
      if (batch) q.batch = batch;
      if (course) q.course = course;
      if (teacher) q.teacher = teacher;

      const list = await CourseInstance.find(q)
        .populate(POP_BATCH)
        .populate(POP_COURSE)
        .populate(POP_TEACHER)
        .sort({ createdAt: -1 })
        .lean();

      const cleaned = hideOrphans
        ? list.filter((ci) => ci.course && ci.batch && ci.teacher) // drop rows with missing refs
        : list;

      res.json({ instances: cleaned });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* -------------------------------- SINGLE ------------------------------ */
CourseInstancerouter.get(
  "/courseInstance/:id",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    try {
      const instance = await CourseInstance.findById(req.params.id)
        .populate({
          path: "batch",
          populate: { path: "faculty", select: "code type programLevel" },
        })
        .populate(POP_COURSE)
        .populate(POP_TEACHER);

      if (!instance) return res.status(404).json({ error: "Not found" });

      const batchId = instance.batch?._id;
      let students = [];
      let studentCount = 0;

      if (batchId) {
        students = await User.find({ batch: batchId, role: "student" })
          .select("_id username email")
          .lean();
        studentCount = students.length;
      }

      res.json({
        instance: { ...instance.toObject(), studentCount, students },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* -------------------------------- UPDATE ------------------------------ */
CourseInstancerouter.patch(
  "/courseInstance/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }
    try {
      const instance = await CourseInstance.findById(req.params.id).populate("course");
      if (!instance) return res.status(404).json({ error: "Not found" });

      // Prevent changing batch or course
      if (req.body.batch || req.body.course) {
        return res
          .status(400)
          .json({ error: "Changing batch or course is not allowed. Delete & recreate instead." });
      }

      // Validate teacher if updating
      if (req.body.teacher) {
        if (!mongoose.Types.ObjectId.isValid(req.body.teacher)) {
          return res.status(400).json({ error: `Invalid teacher ID: ${req.body.teacher}` });
        }
        const t = await User.findById(req.body.teacher).select("role");
        if (!t || t.role !== "teacher") {
          return res.status(400).json({ error: `User ${req.body.teacher} is not a teacher` });
        }
        instance.teacher = req.body.teacher;
      }

      // Only allow isActive for electives (compulsory always true)
      if (typeof req.body.isActive !== "undefined") {
        if (instance.course.type === "compulsory") instance.isActive = true;
        else instance.isActive = !!req.body.isActive;
      }

      ["materials", "assignments", "attendanceRecords", "grades"].forEach((f) => {
        if (req.body[f] !== undefined) instance[f] = req.body[f];
      });

      await instance.save();

      const populated = await CourseInstance.findById(instance._id)
        .populate(POP_BATCH)
        .populate(POP_COURSE)
        .populate(POP_TEACHER)
        .lean();

      res.json({ message: "Updated", instance: populated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* -------------------------------- DELETE ------------------------------ */
CourseInstancerouter.delete(
  "/courseInstance/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }
    try {
      const deleted = await CourseInstance.findByIdAndDelete(req.params.id).lean();
      if (!deleted) return res.status(404).json({ error: "Not found" });
      res.json({ message: "Deleted", instance: deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ---------------------- Students enrolled in instance ------------------ */
CourseInstancerouter.get(
  "/course-instance/:id/students",
  authmiddleware,
  authorizedRole("admin", "teacher"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }
      const instance = await CourseInstance.findById(id).select("batch").lean();
      if (!instance) return res.status(404).json({ error: "Not found" });

      const students = await User.find({ batch: instance.batch, role: "student" })
        .select("_id username email")
        .lean();

      res.json({ count: students.length, students });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ----------------------- Overall course instances ---------------------- */
CourseInstancerouter.get(
  "/overallCourseInstance",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    const started = Date.now();
    const dbg = ["1", "true", "yes", "y", "on"].includes(
      String(req.query.debug || "").toLowerCase()
    );

    try {
      const {
        faculty,           // optional
        semesterOrYear,    // optional
        batch,             // optional
        course,            // optional
        teacher,           // optional
        active,            // optional
        limit = "1000",
      } = req.query;

      const max = Math.min(parseInt(limit, 10) || 1000, 2000);

      // Base filter
      const q = {};
      if (batch) q.batch = batch;
      if (course) q.course = course;
      if (teacher) q.teacher = teacher;

      // Role scoping
      const userRole = req.user?.role;
      if (userRole === "teacher" && !q.teacher) q.teacher = req.user._id;
      if (userRole === "student" && !q.batch) {
        if (!req.user?.batch) {
          return res.status(400).json({ ok: false, error: "Student has no batch assigned" });
        }
        q.batch = req.user.batch;
      }

      // Active flag
      if (typeof active !== "undefined") {
        const s = String(active).toLowerCase();
        if (["1", "true", "yes", "y", "on"].includes(s)) q.isActive = true;
        if (["0", "false", "no", "n", "off"].includes(s)) q.isActive = false;
      }

      // Fetch & populate
      let list = await CourseInstance.find(q)
        .populate({
          ...POP_COURSE,
          // ensure "type" present as well for UI
          select: "name code type semesterOrYear",
        })
        .populate(POP_BATCH)
        .populate(POP_TEACHER)
        .limit(max)
        .lean();

      // In-memory filters for populated docs
      const filtered = list.filter((ci) => {
        const sy = ci?.course?.semesterOrYear; // ObjectId or populated
        const facFromSY = sy?.faculty;
        const facFromBatch = ci?.batch?.faculty;

        if (semesterOrYear && String(sy?._id || sy) !== String(semesterOrYear)) return false;

        if (faculty) {
          const facId =
            (facFromSY && String(facFromSY._id || facFromSY)) ||
            (facFromBatch && String(facFromBatch._id || facFromBatch));
          if (String(faculty) !== String(facId)) return false;
        }
        return true;
      });

      // Sort by course name
      filtered.sort((a, b) => (a?.course?.name || "").localeCompare(b?.course?.name || ""));

      // Shape for frontend
      const items = filtered.map((ci) => ({
        _id: ci._id,
        course: {
          _id: ci.course?._id,
          name: ci.course?.name || "—",
          code: ci.course?.code,
          type: ci.course?.type,
          semesterOrYear: ci.course?.semesterOrYear?._id || ci.course?.semesterOrYear || undefined,
        },
        teacher: {
          _id: ci.teacher?._id,
          name: ci.teacher?.username || ci.teacher?.name || "—",
          email: ci.teacher?.email,
        },
        batch: {
          _id: ci.batch?._id,
          batchname: ci.batch?.batchname || "—",
        },
        isActive: ci.isActive,
      }));

      const tookMs = Date.now() - started;

      if (dbg && process.env.NODE_ENV !== "production") {
        return res.json({
          ok: true,
          count: items.length,
          tookMs,
          filter: q,
          params: req.query,
          items,
        });
      }

      res.json({ ok: true, count: items.length, items });
    } catch (err) {
      if (
        ["1", "true", "yes", "y", "on"].includes(String(req.query.debug || "").toLowerCase()) &&
        process.env.NODE_ENV !== "production"
      ) {
        return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default CourseInstancerouter;
