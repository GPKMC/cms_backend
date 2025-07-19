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
CourseInstancerouter.get('/courseInstance', authmiddleware, authorizedRole("admin"), async (req, res) => {
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
CourseInstancerouter.get('/courseInstance/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  try {
    const instance = await CourseInstance.findById(req.params.id)
      .populate('batch')
      .populate({
        path: 'course',
        populate: {
          path: 'semesterOrYear',
          populate: { path: 'faculty', select: 'name code' }
        }
      })
      .populate({ path: 'teacher', select: 'name email role' });
    if (!instance) return res.status(404).json({ error: 'Not found' });
    res.json({ instance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

export default CourseInstancerouter;
