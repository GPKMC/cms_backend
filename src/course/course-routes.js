import express from 'express';
import mongoose from 'mongoose';
import Course from './course-model.js'; // Adjust path as needed
import SemesterOrYear from '../semoryear/sem-model.js'; // Adjust path as needed
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';

const courseRouter = express.Router();

// Utility: Validate a single course object
async function validateCourse(course) {
  const errors = [];
  const { name, code, semesterOrYear, type } = course;

  if (!name) errors.push('Missing name');
  if (!code) errors.push('Missing code');
  if (!semesterOrYear) errors.push('Missing semesterOrYear');
  if (semesterOrYear && !mongoose.Types.ObjectId.isValid(semesterOrYear)) errors.push('Invalid semesterOrYear ID');
  if (!type || !["compulsory", "elective"].includes(type)) errors.push('Invalid type (must be compulsory or elective)');

  let semesterExists = null;
  if (semesterOrYear && mongoose.Types.ObjectId.isValid(semesterOrYear)) {
    semesterExists = await SemesterOrYear.findById(semesterOrYear);
    if (!semesterExists) errors.push('SemesterOrYear not found');
  }

  return {
    valid: errors.length === 0,
    errors,
    semesterExists,
  };
}

courseRouter.post('/course', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    if (Array.isArray(req.body)) {
      const inserted = [];
      const skipped = [];

      for (const item of req.body) {
        const { valid, errors, semesterExists } = await validateCourse(item);
        if (!valid) {
          skipped.push({ course: item, errors });
          continue;
        }

        const { name, code, description, semesterOrYear, type } = item;

        // Check duplicate code
        const existsCode = await Course.findOne({ code });
        if (existsCode) {
          skipped.push({ course: item, errors: ["Duplicate code"] });
          continue;
        }

        // Check duplicate name for same faculty
        const facultyId = semesterExists.faculty.toString();
        const existsName = await Course.findOne({
          name,
          semesterOrYear: { $in: await SemesterOrYear.find({ faculty: facultyId }).distinct('_id') }
        });

        if (existsName) {
          skipped.push({ course: item, errors: ["Duplicate name within same faculty"] });
          continue;
        }

        const newCourse = new Course({ name, code, description, semesterOrYear, type });
        await newCourse.save();
        inserted.push(await Course.findById(newCourse._id).populate({
          path: 'semesterOrYear',
          populate: { path: 'faculty', select: 'code name' }
        }));
      }

      if (inserted.length === 0) {
        return res.status(400).json({
          message: 'No valid courses inserted.',
          insertedCount: 0,
          skippedCount: skipped.length,
          courses: [],
          skipped,
        });
      }

      return res.status(201).json({
        message: 'Bulk course creation complete.',
        insertedCount: inserted.length,
        skippedCount: skipped.length,
        courses: inserted,
        skipped,
      });
    }

    // Single insert
    const { valid, errors, semesterExists } = await validateCourse(req.body);
    if (!valid) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const { name, code, description, semesterOrYear, type } = req.body;

    // Check duplicate code
    const existsCode = await Course.findOne({ code });
    if (existsCode) {
      return res.status(400).json({ error: 'Duplicate course code.' });
    }

    // Check duplicate name within faculty
    const facultyId = semesterExists.faculty.toString();
    const existsName = await Course.findOne({
      name,
      semesterOrYear: { $in: await SemesterOrYear.find({ faculty: facultyId }).distinct('_id') }
    });

    if (existsName) {
      return res.status(400).json({ error: 'Duplicate course name within the same faculty.' });
    }

    const newCourse = new Course({ name, code, description, semesterOrYear, type });
    await newCourse.save();
    const populatedCourse = await Course.findById(newCourse._id).populate({
      path: 'semesterOrYear',
      populate: { path: 'faculty', select: 'code name' }
    });
    res.status(201).json({
      message: 'Course created successfully',
      course: populatedCourse,
    });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Server error creating course.' });
  }
});
// GET: all courses
courseRouter.get('/course', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { semesterOrYear, faculty, search, type } = req.query;
    const query = {};
    if (semesterOrYear) query.semesterOrYear = semesterOrYear;
    if (type) query.type = type;
    if (faculty) {
      // Find all semesterOrYear of that faculty
      const semesters = await SemesterOrYear.find({ faculty }).select("_id");
      query.semesterOrYear = { $in: semesters.map(s => s._id) };
    }
    if (search) {
      const regex = { $regex: search, $options: "i" };
      query.$or = [
        { name: regex },
        { code: regex },
        { description: regex },
      ];
    }
    const courses = await Course.find(query)
      .populate({
        path: 'semesterOrYear',
        select: 'name semesterNumber yearNumber faculty',
        populate: { path: 'faculty', select: 'code name' }
      })
      .sort({ createdAt: -1 });

    // Format for frontend/UI
    const formatted = courses.map(c => {
      let label = '';
      if (c.semesterOrYear) {
        const s = c.semesterOrYear;
        const ordinal = s.semesterNumber
          ? getOrdinal(s.semesterNumber) + " Semester"
          : s.yearNumber
            ? getOrdinal(s.yearNumber) + " Year"
            : '';
        label = `${ordinal} ${s.faculty?.code?.toUpperCase() || ''}`.trim();
      }
      return {
        _id: c._id,
        name: c.name,
        code: c.code,
        semesterOrYear: label,
        description: c.description,
        slug: c.slug,
        type: c.type,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    res.json({ courses: formatted });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Server error fetching courses.' });
  }
});

// GET: single course by ID
courseRouter.get('/course/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }
  try {
    const course = await Course.findById(id).populate({
      path: 'semesterOrYear',
      populate: { path: 'faculty', select: 'code name' }
    });
    if (!course) {
      return res.status(404).json({ error: 'Course not found.' });
    }
    res.json({ course });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ error: 'Server error fetching course.' });
  }
});

// PATCH: update course
courseRouter.patch('/course/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }
  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found.' });
    }
    // Validate semesterOrYear if being changed
    if (req.body.semesterOrYear) {
      if (!mongoose.Types.ObjectId.isValid(req.body.semesterOrYear)) {
        return res.status(400).json({ error: 'Invalid semesterOrYear ID.' });
      }
      const semesterExists = await SemesterOrYear.findById(req.body.semesterOrYear);
      if (!semesterExists) {
        return res.status(400).json({ error: 'SemesterOrYear not found.' });
      }
    }
    // Validate type if provided
    if (req.body.type && !["compulsory", "elective"].includes(req.body.type)) {
      return res.status(400).json({ error: 'Invalid type. Must be compulsory or elective.' });
    }
    // Only update fields present in req.body (prevent setting to undefined)
   Object.keys(req.body).forEach(key => {
  if (req.body[key] !== undefined && req.body[key] !== null) {
    course[key] = req.body[key];
  }
});

    await course.save();
    const updatedCourse = await Course.findById(id).populate({
      path: 'semesterOrYear',
      populate: { path: 'faculty', select: 'code name' }
    });
    res.json({ message: 'Course updated successfully', course: updatedCourse });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ error: 'Server error updating course.' });
  }
});


// DELETE: by ID
courseRouter.delete('/course/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }
  try {
    const deletedCourse = await Course.findByIdAndDelete(id);
    if (!deletedCourse) {
      return res.status(404).json({ error: 'Course not found.' });
    }
    res.json({ message: 'Course deleted successfully', course: deletedCourse });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ error: 'Server error deleting course.' });
  }
});

// DELETE: all courses
courseRouter.delete('/courses', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const result = await Course.deleteMany({});
    res.json({ message: 'All courses deleted successfully', deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error deleting all courses:', error);
    res.status(500).json({ error: 'Server error deleting all courses.' });
  }
});

// Helper: ordinal suffix
function getOrdinal(n) {
  if (typeof n !== "number") return "";
  const j = n % 10, k = n % 100;
  if (j === 1 && k !== 11) return n + "st";
  if (j === 2 && k !== 12) return n + "nd";
  if (j === 3 && k !== 13) return n + "rd";
  return n + "th";
}

courseRouter.get('/coursecode', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { semesterOrYear, faculty, search, type } = req.query;
    const query = {};

    if (faculty) {
      // Find all semesterOrYear of that faculty
      const semesters = await SemesterOrYear.find({ faculty }).select("_id");
      const semesterIds = semesters.map(s => s._id.toString());

      if (semesterOrYear) {
        // Only include semesterOrYear if it belongs to the faculty's semesters
        if (semesterIds.includes(semesterOrYear.toString())) {
          query.semesterOrYear = semesterOrYear;
        } else {
          // If semesterOrYear is invalid for faculty, return empty
          return res.json({ courses: [] });
        }
      } else {
        query.semesterOrYear = { $in: semesterIds };
      }
    } else if (semesterOrYear) {
      query.semesterOrYear = semesterOrYear;
    }

    if (type) {
      query.type = type;
    }

    if (search) {
      const regex = { $regex: search, $options: "i" };
      query.$or = [
        { name: regex },
        { code: regex },
        { description: regex },
      ];
    }

    const courses = await Course.find(query)
      .populate({
        path: 'semesterOrYear',
        select: 'name semesterNumber yearNumber faculty',
        populate: { path: 'faculty', select: 'code name' }
      })
      .sort({ createdAt: -1 });

    const formatted = courses.map(c => {
      let label = '';
      if (c.semesterOrYear) {
        const s = c.semesterOrYear;
        const ordinal = s.semesterNumber
          ? getOrdinal(s.semesterNumber) + " Semester"
          : s.yearNumber
            ? getOrdinal(s.yearNumber) + " Year"
            : '';
        label = `${ordinal} ${s.faculty?.code?.toUpperCase() || ''}`.trim();
      }
      return {
        _id: c._id,
        name: c.name,
        code: c.code,
        semesterOrYear: label,
        description: c.description,
        slug: c.slug,
        type: c.type,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    res.json({ courses: formatted });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Server error fetching courses.' });
  }
});

export default courseRouter;
