import express from 'express';
import bcrypt from 'bcryptjs';
import User from './user-model.js';
import { authmiddleware } from './user-middleware.js';

const userRouter = express.Router();

function validateEmail(email, role, username) {
  const domain = '@gpkmc.edu.np'; // updated to .edu.np
  if (!email.endsWith(domain)) return false;

  if (role === 'student') {
    // student email format: username.number@gpkmc.edu.np
    const studentEmailRegex = new RegExp(`^${username.toLowerCase()}\\.\\d+${domain}$`);
    return studentEmailRegex.test(email.toLowerCase());
  } else {
    // other roles email format: username@gpkmc.edu.np
    const otherEmailRegex = new RegExp(`^${username.toLowerCase()}${domain}$`);
    return otherEmailRegex.test(email.toLowerCase());
  }
}

// Password validation function
function validatePassword(password) {
  // First char uppercase, at least one number, one special char, min 7 chars
  const passwordRegex = /^[A-Z](?=.*\d)(?=.*[@#$%^&+=!]).{6,}$/;
  return passwordRegex.test(password);
}

const rolePermission = {
  superadmin: ['superadmin', 'admin', 'student', 'teacher'],
  admin: ['teacher', 'student'],
  teacher: [],
  student: [],
};

userRouter.post('/users', authmiddleware, async (req, res) => {
  try {
    const { username, email, password, role = 'student' } = req.body;
    const creatorRole = req.user.role;

    if (!rolePermission[creatorRole]?.includes(role)) {
      return res.status(403).json({
        message: `User with role '${creatorRole}' cannot create users with role '${role}'.`,
      });
    }

    // Validate email format
    if (!validateEmail(email, role, username)) {
      return res.status(400).json({
        field: "email",
        message: `Email format invalid for role '${role}'. Expected ${role === 'student' ? 'username.number' : 'username'}@gpkmc.edu.np`,
      });
    }

    // Validate password format
    if (!validatePassword(password)) {
      return res.status(400).json({
        field: "password",
        message: 'Password must start with an uppercase letter, contain at least one number, one special character, and be at least 7 characters long.',
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      role,
      googleId: null, // ready for future Google login
    });

    await newUser.save();

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default userRouter;
