import express from 'express';
import CourseInstance from '../course/courseinstance-model.js';
import User from '../users/user-model.js'; // ✅ Don't forget this import
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';

const teacherRouter = express.Router();

teacherRouter.get('/my-course-instances', authmiddleware, authorizedRole('teacher'), async (req, res) => {
  try {
    const teacherId = req.user._id;

    const courseInstances = await CourseInstance.find({
      teacher: teacherId,
      isActive: true,
    })
      .populate({
        path: 'batch',
        populate: {
          path: 'faculty',
          select: 'code type programLevel',
        },
      })
      .populate({
        path: 'course',
        populate: {
          path: 'semesterOrYear', // or semesterOrYear
          select: 'name semesterNumber yearNumber status',
        },
      });

    const allWithStudents = await Promise.all(
      courseInstances.map(async (instance) => {
        const students = await User.find({
          role: 'student',
          batch: instance.batch._id,
        }).select('username email isActive');

        return {
          ...instance.toObject(),
          studentCount: students.length,
          students,
        };
      })
    );

    res.json({ success: true, courseInstances: allWithStudents });
  } catch (error) {
    console.error("❌ Error in /my-course-instances:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// GET /teacher-routes/teacher-course-instances/:id
// Admin use: fetch all courseInstances of a teacher by ID
teacherRouter.get(
  '/teacher-course-instances/:id',
  authmiddleware,
  authorizedRole('teacher'), // only admin should call this
  async (req, res) => {
    try {
      const teacherId = req.params.id;

      const courseInstances = await CourseInstance.find({
        teacher: teacherId,
        isActive: true,
      })
        .populate({
          path: 'batch',
          populate: {
            path: 'faculty',
            select: 'code type programLevel',
          },
        })
        .populate({
          path: 'course',
          populate: {
            path: 'semesterOrYear',
            select: 'name semesterNumber yearNumber status',
          },
        });

      const allWithStudents = await Promise.all(
        courseInstances.map(async (instance) => {
          const students = await User.find({
            role: 'student',
            batch: instance.batch._id,
          }).select('username email isActive');

          return {
            ...instance.toObject(),
            studentCount: students.length,
            students,
          };
        })
      );

      res.json({ success: true, courseInstances: allWithStudents });
    } catch (error) {
      console.error("❌ Error in /teacher-course-instances/:id:", error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

export default teacherRouter;
