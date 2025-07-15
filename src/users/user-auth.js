import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Admin from "./admin-model.js";
import adminMiddleware from "./user-middleware.js";


const adminAuthRouter = express.Router();

// POST /admin-auth/login
adminAuthRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required." });

    if (!email.endsWith("@gpkmc.edu.np"))
      return res.status(400).json({ message: "Email must end with @gpkmc.edu.np" });

    const admin = await Admin.findOne({ email });
    if (!admin)
      return res.status(401).json({ message: "Invalid credentials." });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch)
      return res.status(401).json({ message: "Invalid credentials." });

    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(200).json({
      message: "Login successful",
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /admin-auth/me
adminAuthRouter.get("/me", adminMiddleware, async (req, res) => {
  res.status(200).json({
    admin: {
      id: req.admin._id,
      name: req.admin.name,
      email: req.admin.email,
      phone: req.admin.phone,
      createdAt: req.admin.createdAt,
    },
  });
});

export default adminAuthRouter;
 