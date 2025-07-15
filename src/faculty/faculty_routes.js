import express from 'express';
import Faculty from './faculty-model.js';
import { authmiddleware } from '../users/user-middleware.js';
import Batch from '../batch/batch-model.js';

const facultyRouter = express.Router();

// Create one faculty
facultyRouter.post('/faculties', authmiddleware, async (req, res) => {
  try {
    const faculty = await Faculty.create(req.body);
    res.status(201).json({ message: 'Faculty created', faculty });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

facultyRouter.get('/faculties', authmiddleware, async (req, res) => {
  try {
    // use .lean() so mongoose returns plain JS objects we can spread
    const faculties = await Faculty.find()
      .sort({ createdAt: -1 })
      .lean();

    const withCounts = await Promise.all(
      faculties.map(async fac => {
        const totalBatches = await Batch.countDocuments({ faculty: fac._id });
        return { 
          ...fac,
          totalBatches  // just the number
        };
      })
    );

    res.json(withCounts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get one faculty by ID + batch count
facultyRouter.get('/faculties/:id', authmiddleware, async (req, res) => {
  try {
    const faculty = await Faculty.findById(req.params.id);
    if (!faculty) return res.status(404).json({ message: 'Faculty not found' });

    const totalBatches = await Batch.countDocuments({ faculty: faculty._id });
    res.json({ faculty, totalBatches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Update faculty
facultyRouter.put('/faculties/:id',authmiddleware, async (req, res) => {
  try {
    const updated = await Faculty.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Faculty not found' });
    res.json({ message: 'Faculty updated', faculty: updated });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete faculty
facultyRouter.delete('/faculties/:id',authmiddleware, async (req, res) => {
  try {
    const deleted = await Faculty.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Faculty not found' });
    res.json({ message: 'Faculty deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default facultyRouter;
