import express from 'express';
import mongoose from 'mongoose';
import Course from './course-model.js';       // Adjust path as needed
import SemesterOrYear from '../semoryear/sem-model.js';
  // Adjust path as needed

const courseRouter = express.Router();
// Utility: Validate a single course object
async function validateCourse(course) {
  const errors = [];
  const { name, code, semester } = course;

  if (!name) errors.push('Missing name');
  if (!code) errors.push('Missing code');
  if (!semester) errors.push('Missing semester');
  if (semester && !mongoose.Types.ObjectId.isValid(semester)) errors.push('Invalid semester ID');

  let semesterExists = null;
  if (semester && mongoose.Types.ObjectId.isValid(semester)) {
    semesterExists = await SemesterOrYear.findById(semester);
    if (!semesterExists) errors.push('Semester not found');
  }

  return {
    valid: errors.length === 0,
    errors,
    semesterExists,
  };
}

courseRouter.post('/course', async (req, res) => {
  try {
    // Bulk insert
    if (Array.isArray(req.body)) {
      const inserted = [];
      const skipped = [];
      for (const item of req.body) {
        const { valid, errors } = await validateCourse(item);
        if (!valid) {
          skipped.push({ course: item, errors });
          continue;
        }
        const { name, code, description, semester } = item;
        const newCourse = new Course({ name, code, description, semester });
        await newCourse.save();
        inserted.push(await Course.findById(newCourse._id).populate('semester'));
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
    const { valid, errors } = await validateCourse(req.body);
    if (!valid) {
      return res.status(400).json({ error: errors.join(', ') });
    }
    const { name, code, description, semester } = req.body;
    const newCourse = new Course({ name, code, description, semester });
    await newCourse.save();
    const populatedCourse = await Course.findById(newCourse._id).populate('semester');
    res.status(201).json({
      message: 'Course created successfully',
      course: populatedCourse,
    });

  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Server error creating course.' });
  }
});


courseRouter.get('/course', async (req, res) => {
  try {
    // Populate semester (only what you need)
    const courses = await Course.find()
      .populate({
        path: 'semester',
        select: 'semesterNumber faculty',
        populate: { path: 'faculty', select: 'code' }
      })
      .sort({ createdAt: -1 });

    // Format each course
    const formatted = courses.map(c => {
      let semesterLabel = '';
      if (c.semester) {
        // Convert number to ordinal (1st, 2nd, 3rd, etc.)
        const ordinals = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
        semesterLabel = `${ordinals[c.semester.semesterNumber] || c.semester.semesterNumber + 'th'} Semester ${c.semester.faculty?.code?.toUpperCase() || ''}`.trim();
      }
      return {
        _id: c._id,
        name: c.name,
        code: c.code,
        semester: semesterLabel,
        materials: c.materials,
        assignments: c.assignments,
        attendanceRecords: c.attendanceRecords,
        grades: c.grades,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        slug: c.slug
      };
    });

    res.json({ courses: formatted });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Server error fetching courses.' });
  }
});


// Get single course by ID
courseRouter.get('/course/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }

  try {
    const course = await Course.findById(id).populate('semester');
    if (!course) {
      return res.status(404).json({ error: 'Course not found.' });
    }
    res.json({ course });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ error: 'Server error fetching course.' });
  }
});

// Update course partially
courseRouter.patch('/course/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }

  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found.' });
    }

    // If semester is updated, validate it
    if (req.body.semester && !mongoose.Types.ObjectId.isValid(req.body.semester)) {
      return res.status(400).json({ error: 'Invalid semester ID.' });
    }
    if (req.body.semester) {
      const semesterExists = await SemesterOrYear.findById(req.body.semester);
      if (!semesterExists) {
        return res.status(400).json({ error: 'Semester not found.' });
      }
    }

    // Update fields provided
    Object.keys(req.body).forEach(key => {
      course[key] = req.body[key];
    });

    await course.save();

    const updatedCourse = await Course.findById(id).populate('semester');

    res.json({ message: 'Course updated successfully', course: updatedCourse });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ error: 'Server error updating course.' });
  }
});

// Delete course bu id
courseRouter.delete('/course/:id', async (req, res) => {
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
// Delete all courses
courseRouter.delete('/courses', async (req, res) => {
  try {
    const result = await Course.deleteMany({});
    res.json({ message: 'All courses deleted successfully', deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error deleting all courses:', error);
    res.status(500).json({ error: 'Server error deleting all courses.' });
  }
});

export default courseRouter;
