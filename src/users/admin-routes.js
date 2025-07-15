// routes/admin-routes.js
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Admin from './admin-model.js';
import adminMiddleware from './user-middleware.js';

const adminRouter = express.Router();

// Strong password regex
const isStrongPassword = (password) => {
  return /^(?=.*[A-Z])(?=.*\d)(?=.*[*&^%$#@!])[A-Za-z\d*&^%$#@!]{6,}$/.test(password);
};

// ✅ GET all admins
adminRouter.get('/admins', adminMiddleware, async (req, res) => {
  try {
    const admins = await Admin.find().select('-password');
    res.status(200).json({ success: true, admins });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ GET admin by ID
adminRouter.get('/admins/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid admin ID' });
  }

  try {
    const admin = await Admin.findById(id).select('-password');
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    res.status(200).json({ success: true, admin });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ CREATE admin
adminRouter.post('/admins', adminMiddleware, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!email.endsWith('@gpkmc.edu.np')) {
      return res.status(400).json({ success: false, message: 'Email must end with @gpkmc.edu.np' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must start with capital letter, contain a number and one special char (*&^%$#@!), min 6 chars.',
      });
    }

    if (phone && !/^(96|97|98)\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Phone must start with 96, 97, or 98 and be exactly 10 digits',
      });
    }

    const existingAdmin = await Admin.findOne({ $or: [{ email }, { phone }] });
    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Admin with this email or phone already exists',
      });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newAdmin = new Admin({ name, email, password: hashed, phone });
    await newAdmin.save();

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      admin: {
        id: newAdmin._id,
        name: newAdmin.name,
        email: newAdmin.email,
        phone: newAdmin.phone,
        createdAt: newAdmin.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ UPDATE admin (no password, only update `updatedAt`)
adminRouter.patch('/admins/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid admin ID' });
  }

  const updates = {};
  const allowedFields = ['name', 'email', 'phone'];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (updates.email && !updates.email.endsWith('@gpkmc.edu.np')) {
    return res.status(400).json({ success: false, message: 'Email must end with @gpkmc.edu.np' });
  }

  if (updates.phone && !/^(96|97|98)\d{8}$/.test(updates.phone)) {
    return res.status(400).json({
      success: false,
      message: 'Phone must start with 96, 97, or 98 and be exactly 10 digits',
    });
  }

  if (updates.email || updates.phone) {
    const existing = await Admin.findOne({
      _id: { $ne: id },
      $or: [
        updates.email ? { email: updates.email } : null,
        updates.phone ? { phone: updates.phone } : null,
      ].filter(Boolean),
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Another admin already uses this email or phone',
      });
    }
  }

  try {
    const updated = await Admin.findByIdAndUpdate(
      id,
      { ...updates },
      { new: true, runValidators: true }
    ).select('-password');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    res.status(200).json({ success: true, admin: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ DELETE admin
adminRouter.delete('/admins/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid admin ID' });
  }

  try {
    const deleted = await Admin.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    res.status(200).json({ success: true, message: 'Admin deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default adminRouter;
