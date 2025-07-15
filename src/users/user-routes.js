import express from 'express';
import bcrypt from 'bcryptjs';
import User from './user-model.js';
import { authmiddleware } from './user-middleware.js';
import { upload } from '../middleware/upload.js';

const userRouter = express.Router();

// Email validation function
function normalizeName(name) {
  return name.toLowerCase().replace(/\s+/g, ''); // remove all spaces, lowercase
}

function getFirstName(username) {
  return username.split(' ')[0].toLowerCase();
}

function validateEmail(email, role, username) {
  const domain = '@gpkmc.edu.np';
    if (typeof email !== 'string' || !email) return false;  
  if (!email.endsWith(domain)) return false;

  const fullNameNormalized = normalizeName(username);
  const firstName = getFirstName(username);

  if (role === 'student') {
    // student email must be username.number@gpkmc.edu.np
    // Accept either fullName.number or firstName.number
    const regexFullName = new RegExp(`^${fullNameNormalized}\\.\\d+${domain}$`);
    const regexFirstName = new RegExp(`^${firstName}\\.\\d+${domain}$`);
    return regexFullName.test(email.toLowerCase()) || regexFirstName.test(email.toLowerCase());
  } else {
    // for other roles, accept either fullName or firstName without number
    const regexFullName = new RegExp(`^${fullNameNormalized}${domain}$`);
    const regexFirstName = new RegExp(`^${firstName}${domain}$`);
    return regexFullName.test(email.toLowerCase()) || regexFirstName.test(email.toLowerCase());
  }
}


// Password validation function
function validatePassword(password) {
  const passwordRegex = /^[A-Z](?=.*\d)(?=.*[@#$%^&+=!*]).{6,}$/;
  return passwordRegex.test(password);
}

// Roles and who can create what
const rolePermission = {
  superadmin: ['superadmin', 'admin', 'student', 'teacher'],
  admin: ['teacher', 'student'],
  teacher: [],
  student: [],
};

// Route to create users
userRouter.post('/users', authmiddleware, async (req, res) => {
  try {
    const { username, email, password, role = 'student' } = req.body;
    const creatorRole = req.user.role;
    
    if (!rolePermission[creatorRole]?.includes(role)) {
      return res.status(403).json({
        message: `User with role '${creatorRole}' cannot create users with role '${role}'.`,
      });
    }

    if (!validateEmail(email, role, username)) {
      return res.status(400).json({
        field: "email",
        message: `Email format invalid for role '${role}'. Expected ${role === 'student' ? 'username.number' : 'username'}@gpkmc.edu.np`,
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        field: "password",
        message: 'Password must start with an uppercase letter, contain at least one number, one special character, and be at least 7 characters long.',
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      role,
      googleId: null,
      // isActive,
      // isVerified
    });

    await newUser.save();

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        googleId : newUser.googleId,
        isActive : newUser.isActive,
        isVerified : newUser.isVerified

      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

//bulk creation
userRouter.post('/users/bulk', authmiddleware, upload.single('file'), async (req, res) => {
  try {
    const creatorRole = req.user.role;
    const usersToInsert = [];

    // 1️⃣ CSV Upload Case
    if (req.file) {
      const usersFromCSV = await parseCSV(req.file.path);

      if (!Array.isArray(usersFromCSV) || usersFromCSV.length === 0) {
        return res.status(400).json({ message: 'CSV file is empty or invalid.' });
      }

      for (const row of usersFromCSV) {
        const { username, email, password, role } = row;

        if (!username || !email || !password || !role) {
          return res.status(400).json({ message: 'Each row must have username, email, password, and role.' });
        }
        if (!rolePermission[creatorRole]?.includes(role)) {
          return res.status(403).json({ message: `Role '${creatorRole}' cannot create role '${role}'.` });
        }
        if (!validateEmail(email, role, username)) {
          return res.status(400).json({
            field: 'email',
            message: `Email format invalid for role '${role}'. Expected ${role === 'student' ? 'username.number' : 'username'}@gpkmc.edu.np`,
          });
        }
        if (!validatePassword(password)) {
          return res.status(400).json({ field: 'password', message: 'Password does not meet criteria.' });
        }

        usersToInsert.push({
          username,
          email,
          password: await bcrypt.hash(password, 10),
          role,
          googleId: null,
          isActive: true,
          isVerified: false,
        });
      }
    }

    // 2️⃣ Manual JSON Case
    else if (Array.isArray(req.body.users)) {
      for (const user of req.body.users) {
        const { username, email, password, role } = user;

        if (!username || !email || !password || !role) {
          return res.status(400).json({ message: 'Each user must have username, email, password, and role.' });
        }
        if (!rolePermission[creatorRole]?.includes(role)) {
          return res.status(403).json({ message: `Role '${creatorRole}' cannot create role '${role}'.` });
        }
        if (!validateEmail(email, role, username)) {
          return res.status(400).json({
            field: 'email',
            message: `Email format invalid for role '${role}'. Expected ${role === 'student' ? 'username.number' : 'username'}@gpkmc.edu.np`,
          });
        }
        if (!validatePassword(password)) {
          return res.status(400).json({ field: 'password', message: 'Password does not meet criteria.' });
        }

        usersToInsert.push({
          username,
          email,
          password: await bcrypt.hash(password, 10),
          role,
          googleId: null,
          isActive: true,
          isVerified: false,
        });
      }
    }

    // ❗ Neither CSV nor JSON provided
    else {
      return res.status(400).json({ message: 'Provide either a CSV file *or* a "users" array in JSON body.' });
    }

    // Check for duplicates before inserting
    const emails = usersToInsert.map((u) => u.email);
    const existing = await User.find({ email: { $in: emails } });
    if (existing.length > 0) {
      return res.status(400).json({ message: `Users with these emails already exist: ${existing.map((u) => u.email).join(', ')}` });
    }

    const inserted = await User.insertMany(usersToInsert);

    return res.status(201).json({
      message: `${inserted.length} users created successfully.`,
      users: inserted.map((u) => ({
        id: u._id,
        username: u.username,
        email: u.email,
        role: u.role,
        isActive: u.isActive,
        isVerified: u.isVerified,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Route to get users (Admin and Superadmin only)
// Route to get all users (No auth for now)
userRouter.get('/users', async (req, res) => {
  try {
    const { role, search = "", limit = 0 } = req.query;

    const filter = {};

    if (role && role !== "all") {
      filter.role = role;
    }

    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ username: regex }, { email: regex }];
    }

    const totalCount = await User.countDocuments(filter);

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })  // <-- Here
      .limit(Number(limit));

    res.json({ users, totalCount });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});



export default userRouter;
