// routes/user.routes.js
import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "./user-model.js";
import Batch from "../batch/batch-model.js"; // adjust if needed
import Faculty from "../faculty/faculty-model.js"; // <-- NEW: adjust path to your Faculty model
import { authmiddleware, authorizedRole } from "./user-middleware.js";
import { upload } from "../middleware/upload.js";
import { parseCSV } from "../utlis/parseCsv.js";

const userRouter = express.Router();

/* -------------------- helpers -------------------- */
function normalizeName(name = "") {
  return String(name).toLowerCase().replace(/\s+/g, "");
}
function getFirstName(username = "") {
  const parts = String(username).trim().split(/\s+/);
  return parts[0]?.toLowerCase() || "";
}
function validateEmail(email, role, username) {
  const domain = "@gpkmc.edu.np";
  if (typeof email !== "string" || !email) return false;
  const lower = email.toLowerCase().trim();
  if (!lower.endsWith(domain)) return false;

  const fullNameNormalized = normalizeName(username);
  const firstName = getFirstName(username);

  if (role === "student") {
    const regexFullName = new RegExp(`^${fullNameNormalized}\\.\\d+${domain}$`);
    const regexFirstName = new RegExp(`^${firstName}\\.\\d+${domain}$`);
    return regexFullName.test(lower) || regexFirstName.test(lower);
  } else {
    const regexFullName = new RegExp(`^${fullNameNormalized}${domain}$`);
    const regexFirstName = new RegExp(`^${firstName}${domain}$`);
    return regexFullName.test(lower) || regexFirstName.test(lower);
  }
}
function validatePassword(password) {
  // Start Uppercase, at least one digit, at least one special, length >= 7
  const passwordRegex = /^[A-Z](?=.*\d)(?=.*[@#$%^&+=!*]).{6,}$/;
  return passwordRegex.test(password || "");
}
const rolePermission = {
  superadmin: ["superadmin", "admin", "student", "teacher"],
  admin: ["teacher", "student", "admin"],
  teacher: [],
  student: [],
};
async function validateBatchForStudent(batchId) {
  if (!batchId) return { valid: false, message: "Batch is required for students." };
  if (!mongoose.Types.ObjectId.isValid(batchId)) return { valid: false, message: "Invalid batch ID." };
  const batchExists = await Batch.findById(batchId).lean();
  if (!batchExists) return { valid: false, message: "Batch not found." };
  return { valid: true };
}
function isObjectId(v) {
  return mongoose.Types.ObjectId.isValid(v);
}
function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve Faculty by _id OR code/name (case-insensitive). Cached per request. */
async function resolveFacultyId(input, cache) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (cache[key]) return cache[key];

  let facId = null;
  if (isObjectId(input)) {
    const hit = await Faculty.findById(input).select("_id");
    if (hit) facId = hit._id.toString();
  } else {
    const hit = await Faculty.findOne({
      $or: [
        { code: new RegExp(`^${escRe(key)}$`, "i") },
        { name: new RegExp(`^${escRe(key)}$`, "i") },
      ],
    }).select("_id");
    if (hit) facId = hit._id.toString();
  }
  cache[key] = facId;
  return facId;
}

/** Resolve Batch under a faculty by:
 *   - _id (verifies it belongs to faculty)
 *   - start year / year (number)
 *   - batchname or code (exact, case-insensitive)
 */
async function resolveBatchId({ facultyId, batchInput }) {
  if (!batchInput || !facultyId) return null;

  // If it's an ObjectId, ensure it belongs to the faculty
  if (isObjectId(batchInput)) {
    const b = await Batch.findOne({ _id: batchInput, faculty: facultyId }).select("_id");
    return b ? b._id.toString() : null;
  }

  const key = String(batchInput).trim();
  const maybeYear = Number(key);

  const orConds = [];
  if (Number.isFinite(maybeYear)) {
    // Use whichever you actually have in your schema (year / startYear / start_year)
    orConds.push({ year: maybeYear }, { startYear: maybeYear }, { start_year: maybeYear });
  }
  // Also allow exact match on batchname/code (case-insensitive)
  orConds.push(
    { batchname: new RegExp(`^${escRe(key)}$`, "i") },
    { code: new RegExp(`^${escRe(key)}$`, "i") }
  );

  const doc = await Batch.findOne({ faculty: facultyId, $or: orConds }).select("_id");
  return doc ? doc._id.toString() : null;
}

/* -------------------- routes -------------------- */

// POST create single user
userRouter.post("/users", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { username, email, password, role = "student", batch } = req.body;
    const creatorRole = req.user.role;

    if (!rolePermission[creatorRole]?.includes(role)) {
      return res.status(403).json({
        message: `User with role '${creatorRole}' cannot create users with role '${role}'.`,
      });
    }

    if (!validateEmail(email, role, username)) {
      return res.status(400).json({
        field: "email",
        message: `Email format invalid for role '${role}'. Expected ${
          role === "student" ? "username.number" : "username"
        }@gpkmc.edu.np`,
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        field: "password",
        message:
          "Password must start with an uppercase letter, contain at least one number, one special character, and be at least 7 characters long.",
      });
    }

    if (role === "student") {
      const batchValidation = await validateBatchForStudent(batch);
      if (!batchValidation.valid) {
        return res.status(400).json({ field: "batch", message: batchValidation.message });
      }
    } else {
      if (batch) {
        return res.status(400).json({ field: "batch", message: "Batch can only be assigned to students." });
      }
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      role,
      googleId: null,
      batch: role === "student" ? batch : undefined,
    });

    await newUser.save();

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        googleId: newUser.googleId,
        batch: newUser.batch,
        isActive: newUser.isActive,
        isVerified: newUser.isVerified,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// BULK create users (CSV or JSON)
userRouter.post(
  "/users/bulk",
  authmiddleware,
  authorizedRole("admin"),
  upload.single("file"),
  async (req, res) => {
    try {
      const creatorRole = req.user.role;

      if (!req.file && (!req.body.users || !Array.isArray(req.body.users))) {
        return res.status(400).json({
          message: 'Please provide either a CSV file upload or a "users" array in the JSON body.',
        });
      }

      const usersToInsert = [];
      const facultyCache = Object.create(null);

      // A small sanitizer so CSV quirks don't break validation
      const sanitizeRow = (row) => {
        let {
          username = "",
          email = "",
          password = "",
          role = "",
          batch = "",
          faculty = "",
        } = row || {};

        username = String(username).trim();
        // fix 'aakash .703...' -> 'aakash.703...'
        email = String(email).trim().replace(/\s+\./g, ".").toLowerCase();
        password = String(password).trim();
        role = String(role).trim().toLowerCase();
        batch = String(batch).trim();
        faculty = String(faculty).trim();

        return { username, email, password, role, batch, faculty };
      };

      // ---------- CSV case ----------
      if (req.file) {
        const rows = await parseCSV(req.file.path);
        if (!Array.isArray(rows) || rows.length === 0) {
          return res.status(400).json({ message: "CSV file is empty or invalid." });
        }

        for (let i = 0; i < rows.length; i++) {
          let { username, email, password, role, batch, faculty } = sanitizeRow(rows[i]);

          // Requireds
          if (!username || !email || !password || !role) {
            const missingField = !username ? "username" : !email ? "email" : !password ? "password" : "role";
            return res.status(400).json({
              rowIndex: i,
              field: missingField,
              message: "Each row must have username, email, password, and role.",
            });
          }

          if (!rolePermission[creatorRole]?.includes(role)) {
            return res.status(403).json({
              rowIndex: i,
              field: "role",
              message: `Role '${creatorRole}' cannot create role '${role}'.`,
            });
          }

          if (!validateEmail(email, role, username)) {
            return res.status(400).json({
              rowIndex: i,
              field: "email",
              message: `Email format invalid for role '${role}'. Expected ${
                role === "student" ? "username.number" : "username"
              }@gpkmc.edu.np`,
            });
          }

          if (!validatePassword(password)) {
            return res.status(400).json({
              rowIndex: i,
              field: "password",
              message: "Password does not meet criteria.",
            });
          }

          if (role === "student") {
            // NOW: faculty+batch are used to resolve Batch under a Faculty
            if (!faculty) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: "faculty is required for students (to resolve batch under the faculty).",
              });
            }
            const facultyId = await resolveFacultyId(faculty, facultyCache);
            if (!facultyId) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: `Faculty '${faculty}' not found.`,
              });
            }

            const batchId = await resolveBatchId({ facultyId, batchInput: batch });
            if (!batchId) {
              return res.status(400).json({
                rowIndex: i,
                field: "batch",
                message: `Batch '${batch}' not found under faculty '${faculty}'.`,
              });
            }

            batch = batchId; // resolved _id
          } else {
            // Non-students must not include batch/faculty
            if (batch) {
              return res.status(400).json({
                rowIndex: i,
                field: "batch",
                message: "Batch can only be assigned to students.",
              });
            }
            if (faculty) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: "Faculty can only be provided for students.",
              });
            }
          }

          usersToInsert.push({
            username,
            email,
            password: await bcrypt.hash(password, 10),
            role,
            googleId: null,
            batch: role === "student" ? batch : undefined,
            isActive: true,
            isVerified: false,
          });
        }
      }

      // ---------- JSON array case ----------
      else if (Array.isArray(req.body.users)) {
        for (let i = 0; i < req.body.users.length; i++) {
          let { username, email, password, role, batch, faculty } = sanitizeRow(req.body.users[i]);

          if (!username || !email || !password || !role) {
            const missingField = !username ? "username" : !email ? "email" : !password ? "password" : "role";
            return res.status(400).json({
              rowIndex: i,
              field: missingField,
              message: "Each user must have username, email, password, and role.",
            });
          }

          if (!rolePermission[creatorRole]?.includes(role)) {
            return res.status(403).json({
              rowIndex: i,
              field: "role",
              message: `Role '${creatorRole}' cannot create role '${role}'.`,
            });
          }

          if (!validateEmail(email, role, username)) {
            return res.status(400).json({
              rowIndex: i,
              field: "email",
              message: `Email format invalid for role '${role}'. Expected ${
                role === "student" ? "username.number" : "username"
              }@gpkmc.edu.np`,
            });
          }

          if (!validatePassword(password)) {
            return res.status(400).json({
              rowIndex: i,
              field: "password",
              message: "Password does not meet criteria.",
            });
          }

          if (role === "student") {
            if (!faculty) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: "faculty is required for students (to resolve batch under the faculty).",
              });
            }
            const facultyId = await resolveFacultyId(faculty, facultyCache);
            if (!facultyId) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: `Faculty '${faculty}' not found.`,
              });
            }

            const batchId = await resolveBatchId({ facultyId, batchInput: batch });
            if (!batchId) {
              return res.status(400).json({
                rowIndex: i,
                field: "batch",
                message: `Batch '${batch}' not found under faculty '${faculty}'.`,
              });
            }

            batch = batchId;
          } else {
            if (batch) {
              return res.status(400).json({
                rowIndex: i,
                field: "batch",
                message: "Batch can only be assigned to students.",
              });
            }
            if (faculty) {
              return res.status(400).json({
                rowIndex: i,
                field: "faculty",
                message: "Faculty can only be provided for students.",
              });
            }
          }

          usersToInsert.push({
            username,
            email,
            password: await bcrypt.hash(password, 10),
            role,
            googleId: null,
            batch: role === "student" ? batch : undefined,
            isActive: true,
            isVerified: false,
          });
        }
      } else {
        return res.status(400).json({
          message: 'Provide either a CSV file *or* a "users" array in JSON body.',
        });
      }

      // Duplicates by email before inserting
      const emails = usersToInsert.map((u) => u.email);
      const existing = await User.find({ email: { $in: emails } }).select("email");
      if (existing.length > 0) {
        return res.status(400).json({
          message: `Users with these emails already exist: ${existing.map((u) => u.email).join(", ")}`,
        });
      }

      const inserted = await User.insertMany(usersToInsert);

      res.status(201).json({
        message: `${inserted.length} users created successfully.`,
        users: inserted.map((u) => ({
          id: u._id,
          username: u.username,
          email: u.email,
          role: u.role,
          batch: u.batch,
          isActive: u.isActive,
          isVerified: u.isVerified,
        })),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH update user
userRouter.patch("/users/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const { username, email, password, role, batch, isActive, isVerified } = req.body;

    if (email && !validateEmail(email, user.role, username || user.username)) {
      return res.status(400).json({ field: "email", message: "Invalid email format for the user's role" });
    }
    if (password && !validatePassword(password)) {
      return res.status(400).json({ field: "password", message: "Password does not meet criteria" });
    }

    if (user.role === "student") {
      if (batch) {
        if (!mongoose.Types.ObjectId.isValid(batch)) {
          return res.status(400).json({ field: "batch", message: "Invalid batch ID." });
        }
        const batchExists = await Batch.findById(batch);
        if (!batchExists) {
          return res.status(400).json({ field: "batch", message: "Batch not found." });
        }
      }
    } else {
      if (batch) {
        return res.status(400).json({ field: "batch", message: "Batch can only be assigned to students." });
      }
    }

    if (username) user.username = username;
    if (email) user.email = email;
    if (password) user.password = await bcrypt.hash(password, 10);
    if (typeof isActive !== "undefined") user.isActive = isActive;
    if (typeof isVerified !== "undefined") user.isVerified = isVerified;
    if (batch !== undefined) user.batch = batch;
    if (role) user.role = role;

    await user.save();

    res.json({
      message: "User updated successfully",
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        batch: user.batch,
        isActive: user.isActive,
        isVerified: user.isVerified,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE user
userRouter.delete("/users/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET user by ID
userRouter.get("/users/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    const user = await User.findById(req.params.id).select("-password");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET users with filters
userRouter.get("/users", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { role, faculty, batch, search = "", limit = 0 } = req.query;
    const filter = {};

    if (role && role !== "all") filter.role = role;

    if (role === "student" && faculty && mongoose.Types.ObjectId.isValid(faculty)) {
      const batches = await Batch.find({ faculty }).select("_id").lean();
      const batchIds = batches.map((b) => b._id.toString());
      if (batch && mongoose.Types.ObjectId.isValid(batch) && batchIds.includes(batch)) {
        filter.batch = batch;
      } else {
        filter.batch = { $in: batchIds };
      }
    }

    if (search) {
      const regex = new RegExp(search.toString(), "i");
      filter.$or = [{ username: regex }, { email: regex }];
    }

    const totalCount = await User.countDocuments(filter);
    let query = User.find(filter).select("-password").sort({ createdAt: -1 });
    if (Number(limit) > 0) query = query.limit(Number(limit));
    const users = await query.lean();

    res.json({ users, totalCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// CHANGE OWN PASSWORD
userRouter.patch("/users/me/password", authmiddleware, async (req, res) => {
  try {
    const userId = req.user?._id;
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword and newPassword are required." });
    }
    if (!validatePassword(newPassword)) {
      return res.status(400).json({
        field: "newPassword",
        message:
          "Password must start with an uppercase letter, contain at least one number, one special character, and be at least 7 characters long.",
      });
    }

    const user = await User.findById(userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found." });

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) {
      return res.status(400).json({ field: "currentPassword", message: "Current password is incorrect." });
    }
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ field: "newPassword", message: "New password must be different from current password." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Student self profile
userRouter.get("/student/:id", authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    if (String(req.user._id) !== String(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const user = await User.findById(id)
      .select("-password")
      .populate("batch", "batchname year startYear faculty");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role !== "student") {
      return res.status(403).json({ error: "Only students can access this resource." });
    }
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Teacher self profile
userRouter.get("/teacher/:id", authmiddleware, authorizedRole("teacher"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    if (String(req.user._id) !== String(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const user = await User.findById(id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role !== "teacher") {
      return res.status(403).json({ error: "Only teachers can access this resource." });
    }
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

export default userRouter;
