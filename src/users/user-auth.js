// src/users/user-auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import User from "./user-model.js";
import { authmiddleware } from "./user-middleware.js";
import { sendMail } from "../utils/passwod-mailer.js"; // keep your file name

const authRouter = express.Router();

// Helper: generate 6-digit numeric code as a string, e.g. "047281"
function generateSixDigitCode() {
  const buf = crypto.randomBytes(3); // 3 bytes => 0..16,777,215
  const num = buf.readUIntBE(0, 3) % 1000000; // 0..999999
  return num.toString().padStart(6, "0"); // always 6 digits
}

/* ---------- GET /userAuth/me ---------- */
authRouter.get("/me", authmiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        isVerified: user.isVerified,
        googleId: user.googleId,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("GET /me error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- POST /userAuth/login ---------- */
authRouter.post("/login", async (req, res) => {
  try {
    const role = req.body.role;
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = req.body.password;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        message:
          "Your account is disabled. Please contact college administration.",
      });
    }

    if (role && user.role !== role) {
      return res
        .status(403)
        .json({ message: `User does not have the role: ${role}` });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        isVerified: user.isVerified,
        googleId: user.googleId,
      },
    });
  } catch (error) {
    console.error("POST /login error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- POST /userAuth/forgot-password ---------- */
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    // To avoid email enumeration, always send success message
    if (!user || !user.isActive) {
      return res.json({
        message:
          "If an account with that email exists, a reset code has been sent.",
      });
    }

    // Generate a 6-digit code
    const code = generateSixDigitCode();

    // Hash the code before saving
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    user.passwordResetCodeHash = codeHash;
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // +15 minutes
    await user.save();

    // Debug (you can comment this out later)
    console.log("FORGOT DEBUG:", {
      email: normalizedEmail,
      code, // don't log in production
      expiresAt: user.passwordResetExpiresAt,
    });

    const subject = "Your GPKMC eCampus password reset code";
    const text = `Your password reset code is: ${code}

This code will expire in 15 minutes.

If you did not request this, you can ignore this email.`;

    await sendMail({
      to: user.email,
      subject,
      text,
    });

    return res.json({
      message:
        "If an account with that email exists, a reset code has been sent.",
    });
  } catch (err) {
    console.error("Error in /forgot-password", err);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again later." });
  }
});

/* ---------- POST /userAuth/reset-password ---------- */
/* Body: { email, code, newPassword } */
authRouter.post("/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    const normalizedEmail = String(email || "").toLowerCase().trim();
    const trimmedCode = String(code || "").trim();

    if (!normalizedEmail || !trimmedCode || !newPassword) {
      return res.status(400).json({
        message: "Email, code, and new password are required.",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long.",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    // Debug what we actually have in DB
    console.log("RESET DEBUG:", {
      email: normalizedEmail,
      hasUser: !!user,
      passwordResetCodeHash: user?.passwordResetCodeHash,
      passwordResetExpiresAt: user?.passwordResetExpiresAt,
      now: new Date(),
    });

    // no user OR no reset info stored
    if (!user || !user.passwordResetCodeHash || !user.passwordResetExpiresAt) {
      return res.status(400).json({ message: "Invalid or expired code." });
    }

    // check expiry
    if (user.passwordResetExpiresAt.getTime() < Date.now()) {
      user.passwordResetCodeHash = null;
      user.passwordResetExpiresAt = null;
      await user.save();

      return res.status(400).json({ message: "Reset code has expired." });
    }

    // hash incoming code and compare
    const codeHash = crypto.createHash("sha256").update(trimmedCode).digest("hex");

    if (codeHash !== user.passwordResetCodeHash) {
      return res.status(400).json({ message: "Invalid reset code." });
    }

    // 🔴 NEW: prevent using same password as old
    const isSameAsOld = await bcrypt.compare(newPassword, user.password);
    if (isSameAsOld) {
      return res.status(400).json({
        message: "New password must be different from old password.",
      });
    }

    // Code is valid & new password is different → hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    // clear reset fields
    user.passwordResetCodeHash = null;
    user.passwordResetExpiresAt = null;

    await user.save();

    return res.json({
      message: "Password reset successfully. You can log in now.",
    });
  } catch (err) {
    console.error("Error in /reset-password", err);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again later." });
  }
});

export default authRouter;
