import express from 'express';
import Faculty from './faculty-model.js';
import authMiddleware from '../users/user-middleware.js';


const facultyRouter = express.Router();

// Create one faculty
facultyRouter.post('/faculties', authMiddleware("admin"), async (req, res) => {
  try {
    const faculty = await Faculty.create(req.body);
    res.status(201).json({ message: 'Faculty created', faculty });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all faculties
facultyRouter.get('/faculties', authMiddleware("admin"), async (req, res) => {
  try {
    const faculties = await Faculty.find().sort({ createdAt: -1 });
    res.json(faculties); 
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get one faculty by ID
facultyRouter.get('/faculties/:id', authMiddleware("admin"),async (req, res) => {
  try {
    const faculty = await Faculty.findById(req.params.id);
    if (!faculty) return res.status(404).json({ message: 'Faculty not found' });
    res.json({ faculty });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update faculty
facultyRouter.put('/faculties/:id',authMiddleware("admin"), async (req, res) => {
  try {
    const updated = await Faculty.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Faculty not found' });
    res.json({ message: 'Faculty updated', faculty: updated });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete faculty
facultyRouter.delete('/faculties/:id',authMiddleware("admin"), async (req, res) => {
  try {
    const deleted = await Faculty.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Faculty not found' });
    res.json({ message: 'Faculty deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default facultyRouter;
