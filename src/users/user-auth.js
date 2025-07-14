import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import Admin from './admin-model.js';
import Student from './student-model.js';
import Teacher from './teacher-model.js';
import authMiddleware from './user-middleware.js';


const authRouter = express.Router();

const roleModelMap = {
  admin: Admin,
  student: Student,
  teacher: Teacher,
};

// GET logged in user info
authRouter.get('/me/:role', authMiddleware(req => req.params.role), async (req, res) => {
  const role = req.params.role;
  const user = req[role];

  if (!user) {
    return res.status(404).json({ message: `${role} not found` });
  }

  res.status(200).json({
    user: {
      id: user._id,
      username: user.username || user.name,
      email: user.email,
      createdAt: user.createdAt,
    },
  });
});

// LOGIN
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ message: 'Email, password, and role are required.' });
    }

    const Model = roleModelMap[role];
    if (!Model) {
      return res.status(400).json({ message: 'Invalid role provided.' });
    }

    const user = await Model.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const token = jwt.sign({ id: user._id, role }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username || user.name,
        email: user.email,
        role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default authRouter;
