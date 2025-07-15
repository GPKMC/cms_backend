import mongoose from "mongoose";
import express from "express";
// import { authmiddleware } from "../users/user-middleware";
import Batch from "./batch-model.js";
import Faculty from "../faculty/faculty-model.js";



const batchRouter = express.Router();

// batchRouter.js or batch routes file
batchRouter.post('/batch', async (req, res) => {
  try {
    const {
      batchname,
      faculty,
      startYear,
      endYear,
      isCompleted,
      currentSemesterOrYear,
    } = req.body;

    if (!batchname || !faculty || !startYear || !currentSemesterOrYear) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // New validation: startYear should not be greater than endYear
    if (endYear && startYear > endYear) {
      return res.status(400).json({
        success: false,
        message: "Start year cannot be greater than end year.",
      });
    }

 const facultyExists = await Faculty.findOne({ code: facultyCode.trim() });

    if (!facultyExists) {
      return res.status(400).json({ success: false, message: "Faculty does not exist." });
    }

    if (currentSemesterOrYear > facultyExists.totalSemestersOrYears) {
      return res.status(400).json({
        success: false,
        message: `currentSemesterOrYear cannot exceed ${facultyExists.totalSemestersOrYears} for this faculty.`,
      });
    }

    const newBatch = new Batch({
      batchname,
      faculty,
      startYear,
      endYear,
      isCompleted: isCompleted || false,
      currentSemesterOrYear,
    });

    await newBatch.save();

    const populatedBatch = await Batch.findById(newBatch._id).populate('faculty');

    res.status(201).json({ success: true, message: "Batch created successfully", batch: populatedBatch });

  } catch (error) {
    console.error("Error creating batch:", error);
    res.status(500).json({ success: false, message: "Server error creating batch." });
  }
});



// Get all batches
batchRouter.get('/batch', async (req, res) => {
  try {
    const {
      limit = 20,
      search,
      facultyType,      // 'semester' or 'yearly'
      programLevel, // 'bachelor' or 'master'
      isCompleted       // 'true' or 'false'
    } = req.query;

    const query = {};

    // Handle isCompleted filter
    if (isCompleted !== undefined) {
      query.isCompleted = isCompleted === 'true';
    }

    // Handle facultyType filter
    let facultyIds = null;
    if (facultyType === 'semester' || facultyType === 'yearly') {
      const matchedFaculties = await Faculty.find({ type: facultyType }).select('_id');
      facultyIds = matchedFaculties.map(f => f._id);
      query.faculty = { $in: facultyIds };
    }
    // Handle programLevel filter
if (programLevel === 'bachelor' || programLevel === 'master') {
  const matchedFaculties = await Faculty.find({ programLevel }).select('_id');
  const facultyIdsByProgram = matchedFaculties.map(f => f._id);

  if (query.faculty && query.faculty.$in) {
    // Intersect both faculty filters (facultyType + programLevel)
    query.faculty.$in = query.faculty.$in.filter(id =>
      facultyIdsByProgram.includes(id.toString())
    );
  } else {
    query.faculty = { $in: facultyIdsByProgram };
  }
}

    // Handle global search
    if (search) {
      const matchedFaculties = await Faculty.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
          ...(isNaN(Number(search)) ? [] : [{ totalSemestersOrYears: Number(search) }])
        ]
      }).select('_id');

      const searchFacultyIds = matchedFaculties.map(f => f._id);

      query.$or = [
        { batchname: { $regex: search, $options: 'i' } },
        ...(isNaN(Number(search)) ? [] : [{ startYear: Number(search) }]),
        { faculty: { $in: searchFacultyIds } }
      ];
    }

    // Fetch data
    const batches = await Batch.find(query)
      .populate({
        path: 'faculty',
        select: '_id name code type programLevel totalSemestersOrYears'
      })
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    const totalCount = await Batch.countDocuments(query);

    res.json({ success: true, batches, totalCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});



// Get single batch by ID
batchRouter.get('/batch/:id',async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid batch ID" });
  }

  try {
    const batch = await Batch.findById(id).populate('faculty');
    if (!batch) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    res.json({ success: true, batch });
  } catch (error) {
    console.error("Error fetching batch:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update batch partially
batchRouter.patch('/batch/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid batch ID" });
  }

  try {
    const batch = await Batch.findById(id);
    if (!batch) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    // If faculty is updated, check if new faculty exists
    if (req.body.faculty && req.body.faculty !== String(batch.faculty)) {
      const facultyExists = await Faculty.findById(req.body.faculty);
      if (!facultyExists) {
        return res.status(400).json({ success: false, message: "New faculty does not exist." });
      }
      // Optional: Also validate currentSemesterOrYear if provided, since faculty changed
      if (req.body.currentSemesterOrYear !== undefined &&
          req.body.currentSemesterOrYear > facultyExists.totalSemestersOrYears) {
        return res.status(400).json({
          success: false,
          message: `currentSemesterOrYear cannot exceed ${facultyExists.totalSemestersOrYears} for the new faculty.`,
        });
      }
    }

    // Determine which faculty to use for validation
    const facultyIdToCheck = req.body.faculty || batch.faculty;
    const faculty = await Faculty.findById(facultyIdToCheck);

    if (!faculty) {
      return res.status(400).json({ success: false, message: "Faculty not found." });
    }

    // Validate currentSemesterOrYear against faculty.totalSemestersOrYears if provided
    if (req.body.currentSemesterOrYear !== undefined) {
      if (req.body.currentSemesterOrYear > faculty.totalSemestersOrYears) {
        return res.status(400).json({
          success: false,
          message: `currentSemesterOrYear cannot exceed ${faculty.totalSemestersOrYears} for this faculty.`,
        });
      }
    }

    // Update only the provided fields
    Object.keys(req.body).forEach((key) => {
      batch[key] = req.body[key];
    });

    await batch.save();

    const updatedBatch = await Batch.findById(batch._id).populate('faculty');
    res.status(200).json({ success: true, message: "Batch updated successfully", batch: updatedBatch });
  } catch (error) {
    console.error("Error updating batch:", error);
    res.status(500).json({ success: false, message: "Server error updating batch." });
  }
});


// Delete batch by ID
batchRouter.delete('/batch/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid batch ID" });
  }

  try {
    const deletedBatch = await Batch.findByIdAndDelete(id);

    if (!deletedBatch) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    res.status(200).json({ success: true, message: "Batch deleted successfully", batch: deletedBatch });
  } catch (error) {
    console.error("Error deleting batch:", error);
    res.status(500).json({ success: false, message: "Server error deleting batch." });
  }
});

export default batchRouter;
