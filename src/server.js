import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import path from 'path';
import connectDB from './db.js';
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
import cron from 'node-cron';
import { processReferences } from './plagiarism/webiste_url_job.js';
import Submissionrouter from './plagiarism/submission-routes.js';
import questionCommentRouter from './comment/QuestionComment.js';


connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"))
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));
app.use('/user-api', userRouter);
app.use('/userAuth', authRouter);
app.use('/api/auth', googleAuthRouter); // <-- mount Google OAuth routes here
app.use('/faculty-api', facultyRouter);
app.use('/batch-api',batchRouter);
app.use('/batch-api',routBatchPeriodRouter);
app.use('/sem-api',semesterRouter);
app.use ('/course-api',courseRouter);
app.use ('/course-api',CourseInstancerouter);
app.use ('/teacher-routes',teacherRouter)
app.use ('/announcement-routes', CourseAnnouncementrouter);
app.use('/course-materials', CourseMaterialRouter);
app.use ('/topic-api',TopicRouter);
app.use('/assignment', AssignmentRouter);
app.use('/question', QuestionRouter);
app.use('/Coursefeeds', FeedRouter);
app.use('/group-assignment',GroupAssignmentRouter );
app.use('/quizrouter', QuizRouter);
app.use('/student',StudentRoutes);
app.use('/student',StudentFeedRouter);//for materials feed
app.use('/student',taskRouter);//for tasks(assignment,quiz,questions and groupAssignments) feed

app.use('/comment',materialCommentRouter);
app.use('/comment',assignmentCommentRouter);
app.use('/comment',questionCommentRouter);
app.use('/reference',Refroutes);
app.use('/submission',Submissionrouter);

// Run the job immediately on server start
processReferences().catch(console.error);

// Schedule job daily at midnight
cron.schedule('0 0 * * *', () => {
  console.log('Starting daily reference processing job...');
  processReferences().catch(console.error);
});

// cron.schedule('*/5 * * * * *', () => {
//   console.log('Starting reference processing job every 5 seconds...');
//   processReferences().catch(console.error);
// });


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});

