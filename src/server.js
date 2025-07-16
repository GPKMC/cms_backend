import express from 'express';
import 'dotenv/config';
import cors from 'cors';

import connectDB from './db.js';
import userRouter from './users/user-routes.js';
import authRouter from './users/user-auth.js';
import googleAuthRouter from './users/googleAuth.js';
import facultyRouter from './faculty/faculty_routes.js';
import batchRouter from './batch/batch-routes.js';
import semesterRouter from './semoryear/sem-year-routes.js';
import courseRouter from './course/course-routes.js';



connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/user-api', userRouter);
app.use('/userAuth', authRouter);
app.use('/api/auth', googleAuthRouter); // <-- mount Google OAuth routes here
app.use('/faculty-api', facultyRouter);
app.use('/batch-api',batchRouter);
app.use('/sem-api',semesterRouter);
app.use ('/course-api',courseRouter);
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});
