// routes/courseinstance-router.js
import express from 'express';
import mongoose from 'mongoose';
import Course from '../course/course-model.js';
import User from '../users/user-model.js';
import Batch from '../batch/batch-model.js';
import CourseInstance from '../course/courseinstance-model.js';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';

const CourseInstancerouter = express.Router();

async function validateInstance({ batch, course, teacher }) {
  const errors = [];
  if (!batch || !mongoose.Types.ObjectId.isValid(batch)) errors.push('Invalid batch');
  if (!course || !mongoose.Types.ObjectId.isValid(course)) errors.push('Invalid course');
  if (!teacher || !mongoose.Types.ObjectId.isValid(teacher)) {
    errors.push('Invalid teacher ID');
  } else {
    const user = await User.findById(teacher);
    if (!user || user.role !== 'teacher') errors.push(`User ${teacher} is not a teacher`);
  }
  return { valid: errors.length === 0, errors };
}

// CREATE
CourseInstancerouter.post('/courseInstance', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { batch, course, teacher, materials, assignments, attendanceRecords, grades } = req.body;

    const { valid, errors } = await validateInstance({ batch, course, teacher });
    if (!valid) return res.status(400).json({ errors });

    const exists = await CourseInstance.findOne({ batch, course });
    if (exists) return res.status(400).json({ error: 'Instance already exists for this batch and course.' });

    // Find the course and enforce isActive rule
    const courseDoc = await Course.findById(course);
    if (!courseDoc) return res.status(404).json({ error: 'Related course not found.' });

    let isActive;
    if (courseDoc.type === 'compulsory') {
      isActive = true;
    } else if (courseDoc.type === 'elective') {
      // Use the value from request, or default to false
      isActive = typeof req.body.isActive !== "undefined" ? !!req.body.isActive : false;
    }

    const newInstance = new CourseInstance({
      batch,
      course,
      teacher,
      materials,
      assignments,
      attendanceRecords,
      grades,
      isActive,
    });
    await newInstance.save();

    const populated = await CourseInstance.findById(newInstance._id)
      .populate('batch')
      .populate({
        path: 'course',
        populate: {
          path: 'semesterOrYear',
          populate: { path: 'faculty', select: 'name code' }
        }
      })
      .populate({ path: 'teacher', select: 'name email role' });

    res.status(201).json({ message: 'Created', instance: populated });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all
CourseInstancerouter.get('/courseInstance', authmiddleware, authorizedRole("admin","teacher","student"), async (req, res) => {
  try {
    const { batch, course, teacher } = req.query;
    const query = {};
    if (batch) query.batch = batch;
    if (course) query.course = course;
    if (teacher) query.teacher = teacher;

    const list = await CourseInstance.find(query)
      .populate('batch')
      .populate({
        path: 'course',
        populate: {
          path: 'semesterOrYear',
          populate: { path: 'faculty', select: 'name code' }
        }
      })
      .populate({ path: 'teacher', select: 'name email role' });
    res.json({ instances: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single
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
          populate: {
            path: "faculty",
            select: "code type programLevel" // ✅ this fixes your issue
          }
        })
        .populate({
          path: "course",
          select: "name code description type semesterOrYear",
          populate: {
            path: "semesterOrYear",
            populate: { path: "faculty", select: "name code programLevel" },
          },
        })

        .populate({ path: "teacher", select: "_id username email role" });

      if (!instance) return res.status(404).json({ error: "Not found" });

      const batchId = instance.batch?._id;
      let students = [];
      let studentCount = 0;

      if (batchId) {
        students = await User.find({ batch: batchId, role: "student" }).select(
          "_id username email"
        );
        studentCount = students.length;
      }

      res.json({
        instance: {
          ...instance.toObject(),
          studentCount,
          students, // ✅ include all students from the batch
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);




// UPDATE (PATCH)
CourseInstancerouter.patch('/courseInstance/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  try {
    const instance = await CourseInstance.findById(req.params.id).populate('course');
    if (!instance) return res.status(404).json({ error: 'Not found' });

    // Prevent changing batch or course
    if (req.body.batch || req.body.course) {
      return res.status(400).json({ error: 'Changing batch or course is not allowed. Delete and create a new instance if needed.' });
    }

    // Validate teacher if updating
    if (req.body.teacher) {
      if (!mongoose.Types.ObjectId.isValid(req.body.teacher)) {
        return res.status(400).json({ error: `Invalid teacher ID: ${req.body.teacher}` });
      }
      const user = await User.findById(req.body.teacher);
      if (!user || user.role !== 'teacher') {
        return res.status(400).json({ error: `User ${req.body.teacher} is not a teacher` });
      }
      instance.teacher = req.body.teacher;
    }

    // Only allow isActive for electives
    if (typeof req.body.isActive !== "undefined") {
      const courseDoc = instance.course;
      if (courseDoc.type === 'compulsory') {
        instance.isActive = true; // always true
      } else if (courseDoc.type === 'elective') {
        instance.isActive = !!req.body.isActive;
      }
    }

    ['materials', 'assignments', 'attendanceRecords', 'grades'].forEach(field => {
      if (req.body[field] !== undefined) {
        instance[field] = req.body[field];
      }
    });

    await instance.save();

    const populated = await CourseInstance.findById(instance._id)
      .populate('batch')
      .populate({
        path: 'course',
        populate: {
          path: 'semesterOrYear',
          populate: { path: 'faculty', select: 'name code' }
        }
      })
      .populate({ path: 'teacher', select: 'name email role' });

    res.json({ message: 'Updated', instance: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single
CourseInstancerouter.delete('/courseInstance/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  try {
    const deleted = await CourseInstance.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted', instance: deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//get students in a course instance
CourseInstancerouter.get("/course-instance/:id/students", async (req, res) => {
  const { id } = req.params;
  const instance = await CourseInstance.findById(id);
  if (!instance) return res.status(404).json({ error: "Not found" });

  const students = await User.find({
    batch: instance.batch,
    role: "student"
  }).select("username email _id");
  res.json(students);
});

// GET all (with filters + shape for frontend schedule UI)
CourseInstancerouter.get(
  "/overallCourseInstance",
  authmiddleware,
  authorizedRole("admin", "teacher", "student"),
  async (req, res) => {
    const started = Date.now();
    const dbg = ["1","true","yes","y","on"].includes(String(req.query.debug || "").toLowerCase());

    try {
      const {
        faculty,           // optional
        semesterOrYear,    // optional
        batch,             // optional
        course,            // optional
        teacher,           // optional
        active,            // optional truthy -> isActive=true/false
        limit = "1000",
      } = req.query;

      const max = Math.min(parseInt(limit, 10) || 1000, 2000);

      // ---- Build Mongo filter (only direct refs here) ----
      const q = {};
      if (batch)   q.batch = batch;
      if (course)  q.course = course;
      if (teacher) q.teacher = teacher;

      const userRole = req.user?.role;
      if (dbg) {
        console.log("[CIv2] user:", { id: String(req.user?._id || ""), role: userRole });
        console.log("[CIv2] raw query params:", req.query);
      }

      // Role scoping
      if (userRole === "teacher" && !q.teacher) {
        q.teacher = req.user._id;
      }
      if (userRole === "student" && !q.batch) {
        if (!req.user?.batch) {
          if (dbg) console.warn("[CIv2] student has no batch");
          return res.status(400).json({ ok: false, error: "Student has no batch assigned" });
        }
        q.batch = req.user.batch;
      }

      // Optional active flag
      if (typeof active !== "undefined") {
        const s = String(active).toLowerCase();
        if (["1","true","yes","y","on"].includes(s))  q.isActive = true;
        if (["0","false","no","n","off"].includes(s)) q.isActive = false;
      }

      if (dbg) console.log("[CIv2] mongo filter:", q);

      // ---- Fetch + populate (filter by faculty/semester after populate) ----
      let list = await CourseInstance.find(q)
        .populate({
          path: "course",
          select: "name code semesterOrYear",
          populate: { path: "semesterOrYear", select: "name faculty" },
        })
        .populate({ path: "batch", select: "batchname faculty" })
        .populate({ path: "teacher", select: "name username email role" })
        // .sort({ "course.name": 1 }) // <-- don't sort by populated path in DB
        .limit(max)
        .lean();

      // sort by course name in JS after populate
      list.sort((a, b) => (a?.course?.name || "").localeCompare(b?.course?.name || ""));

      if (dbg) console.log("[CIv2] fetched count:", list.length);

      // ---- In-memory filters that depend on populated docs ----
      const filtered = list.filter((ci) => {
        const sy = ci?.course?.semesterOrYear;        // ObjectId or populated doc
        const facFromSY = sy?.faculty;                // ObjectId or populated doc
        const facFromBatch = ci?.batch?.faculty;      // ObjectId or populated doc

        if (semesterOrYear && String(sy?._id || sy) !== String(semesterOrYear)) return false;

        if (faculty) {
          const facId =
            (facFromSY && String(facFromSY._id || facFromSY)) ||
            (facFromBatch && String(facFromBatch._id || facFromBatch));
          if (String(faculty) !== String(facId)) return false;
        }
        return true;
      });

      if (dbg) {
        console.log("[CIv2] filtered count:", filtered.length);
        // log a tiny sample so console isn't spammed
        console.log("[CIv2] sample item:", JSON.stringify(filtered[0] || {}, null, 2));
      }

      // ---- Shape for frontend ----
      const items = filtered.map((ci) => ({
        _id: ci._id,
        course: {
          _id: ci.course?._id,
          name: ci.course?.name || "—",
          code: ci.course?.code,
          semesterOrYear: ci.course?.semesterOrYear?._id || ci.course?.semesterOrYear || undefined,
        },
        teacher: {
          _id: ci.teacher?._id,
          name: ci.teacher?.name || ci.teacher?.username || "—",
          email: ci.teacher?.email,
        },
        batch: {
          _id: ci.batch?._id,
          batchname: ci.batch?.batchname || "—",
        },
        isActive: ci.isActive,
      }));

      const tookMs = Date.now() - started;

      // When debug=1, include some extra diagnostics in the response (dev only)
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
      console.error("[CIv2] ERROR:", err && err.stack ? err.stack : err);
      // keep the client error terse unless in debug & non-prod
      if (["1","true","yes","y","on"].includes(String(req.query.debug || "").toLowerCase()) &&
          process.env.NODE_ENV !== "production") {
        return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);


export default CourseInstancerouter;
