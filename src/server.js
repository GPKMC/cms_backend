// src/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';

// --- DB ---
import connectDB from './db.js';

// --- Routers (your existing ones) ---
import userRouter from './users/user-routes.js';
import authRouter from './users/user-auth.js';
import googleAuthRouter from './users/googleAuth.js';
import facultyRouter from './faculty/faculty_routes.js';
import batchRouter from './batch/batch-routes.js';
import semesterRouter from './semoryear/sem-year-routes.js';
import courseRouter from './course/course-routes.js';
import CourseInstancerouter from './course/course-instance.js';
import routBatchPeriodRouter from './batch/batchPeriod-routes.js';
import teacherRouter from './teacherRoutes/teacher-routes.js';
import CourseAnnouncementrouter from './course/courseAnnoucement-routes.js';
import CourseMaterialRouter from './course/courseMaterial-routes.js';
import TopicRouter from './course/topic-routes.js';
import AssignmentRouter from './assignment/assignment-router.js';
import FeedRouter from './course/course-feed.js';
import QuestionRouter from './question/question-routes.js';
import GroupAssignmentRouter from './assignment/groupAssignments-routes.js';
import QuizRouter from './quizQuestion/Quizrouter.js';
import StudentRoutes from './student-routes/student-sem.js';
import StudentFeedRouter from './student-routes/material-feed.js';
import materialCommentRouter from './comment/materialComment-routes.js';
import taskRouter from './student-routes/task-feed.js';
import assignmentCommentRouter from './comment/assignmentComment-routes.js';
import Refroutes from './plagiarism/refPost-routes.js';
// import Submissionrouter from './plagiarism/submission-routes.js';
import questionCommentRouter from './comment/QuestionComment.js';
import assignmentSubmissionrouter from './assignment/assignmentSubmission-routes.js';
import QuizSubmissionrouter from './quizQuestion/submission-router.js';
import groupAssignmentSubmissionRouter from './assignment/groupAssignmentSubmission.js';
import questionSubmissionRouter from './question/questionSubmission-routes.js';
import NotificationRouter from './functions/notification-routes.js';
import StudentProgressRouter from './student-routes/student-assignment.js';
import AttendanceRouter from './attendance/attendance-routes.js';
import gradingRouter from './question/gradingrouter.js';
import assignmentGradeRouter from './assignment/assignmentGrade-router.js';
import GroupGradeRouter from './assignment/groupGrade-router.js';
import GradesRouter from './grade/overallGrade-routes.js';
import teacherAssignmentRouter from './teacherRoutes/overallAssignment.js';
import scheduleRouter from './functions/schedule/schedule-event-routes.js';
import teacherAvailabilityRouter from './functions/schedule/teacher-availability-routes.js';
import scheduleEventRouter from './functions/schedule/schedule-solver-routes.js';
import announcementRoutes from './functions/announcement-routes.js';

// ====== Connect DB ======
await connectDB(); // if connectDB() isn't async, remove await

// ====== App ======
const app = express();

const ORIGINS =
  (process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean)) ||
  ['http://localhost:3000'];

app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Static files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ====== HTTP + Socket.io ======
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: ORIGINS, credentials: true },
});

// Room helper for attendance sessions
const roomForSession = (sessionId) => `attendance:session:${sessionId}`;

// (Keep handshake open for now; you can add JWT auth later)
io.on('connection', (socket) => {
  socket.on('join-session', (sessionId, ack) => {
    socket.join(roomForSession(sessionId));
    ack?.({ ok: true });
  });

  socket.on('leave-session', (sessionId) => {
    socket.leave(roomForSession(sessionId));
  });
});

// Expose emitters for routes
io.emitters = {
  attendanceUpdated(sessionId, record) {
    io.to(roomForSession(sessionId)).emit('attendance:updated', { record });
  },
  sessionClosed(sessionId) {
    io.to(roomForSession(sessionId)).emit('attendance:closed', { sessionId: String(sessionId) });
  },
  sessionOpened(session) {
    io.to(roomForSession(session._id)).emit('attendance:opened', { sessionId: String(session._id) });
  },
};

// Attach to requests
app.use((req, _res, next) => {
  req.io = io;
  req.emitters = io.emitters;
  next();
});

// ====== Mount routes ======
app.use('/user-api', userRouter);
app.use('/userAuth', authRouter);
app.use('/api/auth', googleAuthRouter);
app.use('/faculty-api', facultyRouter);
app.use('/batch-api', batchRouter);
app.use('/batch-api', routBatchPeriodRouter);
app.use('/sem-api', semesterRouter);
app.use('/course-api', courseRouter);
app.use('/course-api', CourseInstancerouter);
app.use('/teacher-routes', teacherRouter);
app.use('/announcement-routes', CourseAnnouncementrouter);
app.use('/course-materials', CourseMaterialRouter);
app.use('/topic-api', TopicRouter);
app.use('/assignment', AssignmentRouter);
app.use('/question', QuestionRouter);
app.use('/Coursefeeds', FeedRouter);
app.use('/group-assignment', GroupAssignmentRouter);
app.use('/quizrouter', QuizRouter);
app.use('/student', StudentRoutes);
app.use('/student', StudentFeedRouter); // materials feed
app.use('/student', taskRouter);        // tasks feed
app.use('/comment', materialCommentRouter);
app.use('/comment', assignmentCommentRouter);
app.use('/comment', questionCommentRouter);
app.use('/reference', Refroutes);
app.use('/submission', assignmentSubmissionrouter);
app.use('/groupsubmission', groupAssignmentSubmissionRouter);
app.use('/questionsubmission', questionSubmissionRouter);
app.use('/quiz-submissions', QuizSubmissionrouter);
app.use('/Notification', NotificationRouter);
app.use('/assignmentFeed', StudentProgressRouter);
app.use("/grading", gradingRouter);
app.use("/assignmentgrading", assignmentGradeRouter);
app.use("/groupassignmentgrading", GroupGradeRouter);
app.use("/grade", GradesRouter);
app.use("/overallAssignment", teacherAssignmentRouter);
app.use("/schedule", scheduleRouter);
app.use("/schedule", teacherAvailabilityRouter);
app.use("/schedule", scheduleEventRouter);
app.use("/announcement", announcementRoutes);


// ⚠️ Attendance router mounted at /attendance.
// Ensure the router's internal paths are like "/sessions", NOT "/attendance/sessions".
app.use('/attendance', AttendanceRouter);

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ====== Start ======
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port: ${PORT}`);
  console.log(`🌐 CORS origins: ${ORIGINS.join(', ')}`);
});
