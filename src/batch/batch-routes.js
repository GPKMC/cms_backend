import mongoose from "mongoose";
import express from "express";
// import { authmiddleware } from "../users/user-middleware";
import Batch from "./batch-model.js";
import Faculty from "../faculty/faculty-model.js";

const batchRouter = express.Router();

batchRouter.post('/batch', async (req, res) => {
  try {
    const {
      facultyCode, // e.g., "mEd"
      startYear,
      endYear,
      isCompleted,
      currentSemesterOrYear,
    } = req.body;

    // Validation: Required fields
    if (!facultyCode || !startYear || !currentSemesterOrYear) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: facultyCode, startYear, or currentSemesterOrYear.',
      });
    }

    // Validation: startYear vs endYear
    if (endYear && startYear > endYear) {
      return res.status(400).json({
        success: false,
        message: 'Start year cannot be greater than end year.',
      });
    }

    // Find faculty (case-insensitive)
    const faculty = await Faculty.findOne({
      code: { $regex: `^${facultyCode.trim()}$`, $options: 'i' },
    });

    if (!faculty) {
      return res.status(400).json({
        success: false,
        message: `Faculty with code '${facultyCode}' does not exist.`,
      });
    }

    // Validation: semester/year range
    if (
      currentSemesterOrYear < 1 ||
      currentSemesterOrYear > faculty.totalSemestersOrYears
    ) {
      return res.status(400).json({
        success: false,
        message: `currentSemesterOrYear must be between 1 and ${faculty.totalSemestersOrYears} for ${faculty.code}.`,
      });
    }

    // Check if batch already exists (same faculty and startYear)
    const existingBatch = await Batch.findOne({
      faculty: faculty._id,
      startYear: startYear,
    });

    if (existingBatch) {
      return res.status(400).json({
        success: false,
        message: `Batch for ${faculty.code} and ${startYear} already exists.`,
      });
    }

    // Generate batchname
    const batchname = `${faculty.code}_${startYear}`;

    // Create batch
    const newBatch = new Batch({
      batchname,
      faculty: faculty._id,
      startYear,
      endYear,
      isCompleted: isCompleted || false,
      currentSemesterOrYear,
    });

    await newBatch.save();

    const populatedBatch = await Batch.findById(newBatch._id).populate('faculty');

    res.status(201).json({
      success: true,
      message: 'Batch created successfully',
      batch: populatedBatch,
    });

  } catch (error) {
    console.error('Error creating batch:', error);
    res.status(500).json({
      success: false,
      message: 'Unexpected error occurred while creating batch.',
      error: error.message,
    });
  }
});

batchRouter.get('/batchcode', async (req, res) => {
  try {
    const facultyId = req.query.faculty;
    const filter = facultyId ? { faculty: facultyId } : {};
    const batches = await Batch.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, batches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all batches
batchRouter.get('/batch', async (req, res) => {
  try {
    const {
      limit = 20,
      search,
      facultyType,
      isCompleted,
      facultyCode,      // e.g. 'BCA', 'MEd', etc.
      programLevel,     // 👈 add this for bachelor/master filter
    } = req.query;

    const query = {};
    let facultyIds = null;

    // Filter by isCompleted
    if (isCompleted !== undefined) {
      query.isCompleted = isCompleted === 'true';
    }

    // Build faculty filters
    const facultyFilter = {};

    // 👇 ADD THIS
    if (programLevel) {
      facultyFilter.programLevel = programLevel;
    }
    // 👆 ADD THIS

    if (facultyType === 'semester' || facultyType === 'yearly') {
      facultyFilter.type = facultyType;
    }

    if (facultyCode) {
      facultyFilter.code = { $regex: `^${facultyCode.trim()}$`, $options: 'i' };
    }

    if (Object.keys(facultyFilter).length > 0) {
      const matchedFaculties = await Faculty.find(facultyFilter).select('_id');
      facultyIds = matchedFaculties.map(f => f._id);
      query.faculty = { $in: facultyIds };
    }

    // Global search
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      const matchedFaculties = await Faculty.find({
        $or: [
          { name: searchRegex },
          { code: searchRegex },
          ...(isNaN(Number(search)) ? [] : [{ totalSemestersOrYears: Number(search) }])
        ]
      }).select('_id');

      const searchFacultyIds = matchedFaculties.map(f => f._id);

      query.$or = [
        { batchname: searchRegex },
        ...(isNaN(Number(search)) ? [] : [{ startYear: Number(search) }]),
        { faculty: { $in: searchFacultyIds } }
      ];
    }

    // Fetch batches
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
    console.error('Error fetching batches:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});





// Get single batch by ID
batchRouter.get('/batch/:id', async (req, res) => {
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
batchRouter.patch('/batch/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid batch ID." });
  }

  try {
    const batch = await Batch.findById(id).populate({
      path: 'faculty',
      select: '_id name code type totalSemestersOrYears'
    });

    if (!batch) {
      return res.status(404).json({ success: false, message: "Batch not found." });
    }

    // Prevent changing faculty after creation
    if (req.body.faculty && req.body.faculty !== String(batch.faculty._id)) {
      return res.status(400).json({ success: false, message: "Faculty cannot be changed once a batch is created." });
    }

    // Validate currentSemesterOrYear against totalSemestersOrYears if provided
    if (req.body.currentSemesterOrYear !== undefined) {
      if (req.body.currentSemesterOrYear > batch.faculty.totalSemestersOrYears) {
        return res.status(400).json({
          success: false,
          message: `currentSemesterOrYear cannot exceed ${batch.faculty.totalSemestersOrYears} for this faculty.`,
        });
      }
      batch.currentSemesterOrYear = req.body.currentSemesterOrYear;
    }

    // Update startYear if provided → regenerate batchname and slug
    if (req.body.startYear) {
      batch.startYear = req.body.startYear;
      const facultyCode = batch.faculty.code.trim();
      batch.batchname = `${facultyCode}_${batch.startYear}`;
      batch.slug = `${facultyCode.toLowerCase()}-${batch.startYear}`;
    }

    // Update other optional fields
    if (req.body.endYear !== undefined) batch.endYear = req.body.endYear;
    if (req.body.isCompleted !== undefined) batch.isCompleted = req.body.isCompleted;

    await batch.save();

    const updatedBatch = await Batch.findById(batch._id).populate({
      path: 'faculty',
      select: '_id name code type totalSemestersOrYears'
    });

    res.status(200).json({
      success: true,
      message: "Batch updated successfully.",
      batch: updatedBatch
    });

  } catch (error) {
    console.error("Error updating batch:", error);
    res.status(500).json({ success: false, message: "Server error updating batch." });
  }
});


export default batchRouter;
