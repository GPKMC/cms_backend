import express from "express";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import User from "../users/user-model.js";
import SemesterOrYear from "../semoryear/sem-model.js";
import mongoose from "mongoose";
import BatchPeriod from "../batch/batchPeriod-model.js";
import CourseInstance from "../course/courseinstance-model.js";
import courseAnnouncementModel from "../course/courseAnnouncement-model.js";
import assignmentModel from "../assignment/assignmentModel.js";
import courseMaterialsModel from "../course/courseMaterials-model.js";
import questionModel from "../question/question-model.js";
import quizquestionModel from "../quizQuestion/quizquestion-model.js";
import groupAssignmentModel from "../assignment/groupAssignment-model.js";

const StudentRoutes = express.Router();

StudentRoutes.get(
  "/my-batch-semesters",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      // 1. Get user, batch, faculty
      const user = await User.findById(req.user.id)
        .populate({ path: "batch", populate: { path: "faculty" } });

      if (!user || !user.batch || !user.batch.faculty)
        return res.status(404).json({ message: "Batch or faculty not found." });

      const batch = user.batch;
      const faculty = batch.faculty;
      const facultyType = faculty.type; // "semester" or "yearly"
      const programLevel = faculty.programLevel; // "bachelor" or "master"
      const current = batch.currentSemesterOrYear; // e.g., 7 for sem, 3 for year
      const total = faculty.totalSemestersOrYears;

      // 2. Get all SemesterOrYear docs for this faculty, sorted
      const semesterOrYears = await SemesterOrYear.find({ faculty: faculty._id })
        .sort(facultyType === "semester" ? { semesterNumber: 1 } : { yearNumber: 1 })
        .lean();

      // 3. Mark unlocked/locked for each
      const data = semesterOrYears.map(s => {
        const n = facultyType === "semester" ? s.semesterNumber : s.yearNumber;
        return {
          ...s,
          unlocked: n <= current,
        };
      });

      res.json({
        faculty: {
          code: faculty.code,
          name: faculty.name,
          programLevel,
          type: facultyType,
          total,
        },
        batch: {
          batchname: batch.batchname,
          current,
        },
        semestersOrYears: data,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error." });
    }
  }
);

// // GET /student/semester-courses?semesterOrYear=<id>
// // routes/student.js
// StudentRoutes.get(
//   "/semester-courses",
//   authmiddleware,
//   authorizedRole("student"),
//   async (req, res) => {
//     const semesterOrYear = req.query.semesterOrYear;
//     if (!semesterOrYear) return res.status(400).json({ message: "Missing ID" });

//     // Fetch semesterOrYear with populated courses
//     const semOrYearDoc = await SemesterOrYear.findById(semesterOrYear).populate("courses");
//     if (!semOrYearDoc) return res.status(404).json({ message: "Semester/Year not found" });

//     res.json({ 
//       courses: semOrYearDoc.courses, 
//       semesterOrYear: { name: semOrYearDoc.name }
//     });
//   }
// );

// Use a clear and RESTful route
StudentRoutes.get('/batch-period/by-semester-or-year/:semesterOrYearId',
  authmiddleware, authorizedRole("student"),
  async (req, res) => {
    const { semesterOrYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(semesterOrYearId)) {
      return res.status(400).json({ message: "Invalid semesterOrYearId" });
    }

    try {
      // 1. Fetch student + batch
      const student = await User.findById(req.user.id);
      if (!student || !student.batch) {
        return res.status(400).json({ message: "No batch assigned to student" });
      }

      // 2. Fetch batchPeriod as usual
      const batchPeriod = await BatchPeriod.findOne({
        batch: student.batch,
        semesterOrYear: semesterOrYearId,
      })
        .populate({
          path: "batch",
          populate: { path: "faculty" }
        })
        .populate({
          path: "semesterOrYear",
          populate: { path: "courses" } // No select! Keep full objects for _id!
        });

      if (!batchPeriod) {
        return res.status(404).json({ message: "BatchPeriod not found for your batch and selected semester/year." });
      }

      // 3. For each course, get its CourseInstance for this batch
      const coursesWithTeacher = await Promise.all(
        batchPeriod.semesterOrYear.courses.map(async (course) => {
          // Find the CourseInstance for this batch+course
          const instance = await CourseInstance.findOne({
            batch: student.batch,
            course: course._id
          }).populate({
            path: 'teacher',
            select: 'username email'
          });

          return {
            _id: course._id,
            name: course.name,
            code: course.code,
            credits: course.credits,
            type: course.type,
            // ADD THIS LINE: Pass CourseInstance _id
            courseInstanceId: instance ? instance._id : undefined,
            assignedTeacher: instance?.teacher
              ? {
                  _id: instance.teacher._id,
                  username: instance.teacher.username,
                  email: instance.teacher.email,
                }
              : null
          };
        })
      );

      // 4. Rebuild the response with updated courses
      const result = {
        ...batchPeriod.toObject(),
        semesterOrYear: {
          ...batchPeriod.semesterOrYear.toObject(),
          courses: coursesWithTeacher,
        }
      };

      res.json({ batchPeriod: result });

    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error. Please try again later." });
    }
  }
);

StudentRoutes.get(
  '/my-course-instances',
  authmiddleware,
  authorizedRole('student'),
  async (req, res) => {
    try {
      const studentId = req.user._id;

      // Get student details to access their batch
      const student = await User.findById(studentId).select('batch');
      if (!student || !student.batch) {
        return res
          .status(404)
          .json({ success: false, message: 'Student or batch not found' });
      }

      const courseInstances = await CourseInstance.find({
        batch: student.batch,
        isActive: true,
      })
        .populate({
          path: 'teacher',
          select: 'username email',
        })
        .populate({
          path: 'course',
          select: 'title description code semesterOrYear', // include description here
          populate: {
            path: 'semesterOrYear',
            select: 'name semesterNumber yearNumber status',
          },
        })
        .populate({
          path: 'batch',
          populate: {
            path: 'faculty',
            select: 'code type programLevel',
          },
        });

      res.json({ success: true, courseInstances });
    } catch (error) {
      console.error('❌ Error in student /my-course-instances:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);
//fetching feed  for student dashboard 
StudentRoutes.get(
  "/course-instance/:id/feed",
  authmiddleware,
  authorizedRole("student", "teacher", "admin"),
  async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid courseInstance ID" });
    }

    try {
      // Fetch all types
      const [announcements, assignments, groupAssignments,materials, quizzes, questions] = await Promise.all([
        courseAnnouncementModel.find({ courseInstance: id })
          .populate("postedBy", "_id username email role")
          .lean(),
        assignmentModel.find({ courseInstance: id })
          .populate("postedBy", "_id username email role")
          .lean(),
        groupAssignmentModel.find({courseInstance :id})
        .populate("postedBy","_id username email role"),
        courseMaterialsModel.find({ courseInstance: id })
          .populate("postedBy", "_id username email role")
          .lean(),
        quizquestionModel.find({ courseInstance: id })
          .populate("postedBy", "_id username email role")
          .lean(),
        questionModel.find({ courseInstance: id })
          .populate("postedBy", "_id username email role")
          .lean(),
      ]);

      // Normalize feed items
      const feed = [
  ...announcements.map(a => ({
    _id: a._id,
  type: "announcement",
  content: a.content,
  images: a.images || [],
  documents: a.documents || [],
  links: a.links || [],
  youtubeLinks: a.youtubeLinks || [],
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  postedBy: a.postedBy,
  })),
  ...assignments.map(a => ({
    _id: a._id,
    type: "assignment",
    title: a.title,
    content: a.content,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    postedBy: a.postedBy,
  })),
  ...materials.map(m => ({
    _id: m._id,
    type: "material",
    title: m.title,
    content: m.content,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    postedBy: m.postedBy,
  })),
  ...quizzes.map(q => ({
    _id: q._id,
    type: "quiz",
    title: q.title,
    content: q.description || "",   // Use description as content!
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    postedBy: q.postedBy,
  })),
  ...questions.map(q => ({
    _id: q._id,
    type: "question",
    title: q.title,
    content: q.content,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    postedBy: q.postedBy,
  })),
  ...groupAssignments.map(g => ({
    _id: g._id,
    type: "groupAssignment",
    title: g.title,
    content: g.content,      // Or .description if your model uses that
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    postedBy: g.postedBy,
  })),
];


      // Sort by updatedAt > createdAt descending
      feed.sort((a, b) =>
        new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
      );

      res.json({ feed });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch feed." });
    }
  }
);

export default StudentRoutes;
