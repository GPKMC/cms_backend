import express from 'express';
import mongoose from 'mongoose';
import Course from './course-model.js';       // Adjust path as needed
import SemesterOrYear from '../semoryear/sem-model.js';
  // Adjust path as needed

const courseRouter = express.Router();

// Create a new course
courseRouter.post('/course', async (req, res) => {
  try {
    const { name, code, description, semester } = req.body;

    // Basic validation
    if (!name || !code || !semester) {
      return res.status(400).json({ error: 'Name, code, and semester are required.' });
    }

    // Validate semester ID
    if (!mongoose.Types.ObjectId.isValid(semester)) {
      return res.status(400).json({ error: 'Invalid semester ID.' });
    }

    const semesterExists = await SemesterOrYear.findById(semester);
    if (!semesterExists) {
      return res.status(400).json({ error: 'Semester not found.' });
    }

    // Create new course
    const newCourse = new Course({
      name,
      code,
      description,
      semester,
    });

    await newCourse.save();

    // Populate semester in response
    const populatedCourse = await Course.findById(newCourse._id).populate('semester');

    res.status(201).json({ message: 'Course created successfully', course: populatedCourse });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Server error creating course.' });
  }
});

// Get all courses
courseRouter.get('/course', async (req, res) => {
  try {
    const courses = await Course.find().populate('semester').sort({ createdAt: -1 });
    res.json({ courses });
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

// Delete course
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

export default courseRouter;
