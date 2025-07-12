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
      facultyCode,
      startYear,
      endYear,
      isCompleted,
      currentSemesterOrYear,
    } = req.body;

    if (!facultyCode || !startYear || !currentSemesterOrYear) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // New validation: startYear should not be greater than endYear
    if (endYear && startYear > endYear) {
      return res.status(400).json({
        success: false,
        message: "Start year cannot be greater than end year.",
      });
    }

    const facultyExists = await Faculty.findOne({ code: facultyCode.toUpperCase().trim() });

    if (!facultyExists) {
      return res.status(400).json({ success: false, message: "Faculty does not exist." });
    }

    if (currentSemesterOrYear > facultyExists.totalSemestersOrYears) {
      return res.status(400).json({
        success: false,
        message: `currentSemesterOrYear cannot exceed ${facultyExists.totalSemestersOrYears} for this faculty.`,
      });
    }

    if (endYear) {
      const yearGap = endYear - startYear;
      if (facultyExists.programLevel === "bachelor") {
        if (yearGap < 4 || yearGap > 5) {
          return res.status(400).json({
            success: false,
            message: `For Bachelor programs, the end year must be 4 to 5 years after the start year.`,
          });
        }
      } else if (facultyExists.programLevel === "master") {
        if (yearGap < 2 || yearGap > 3) {
          return res.status(400).json({
            success: false,
            message: `For Master programs, the end year must be 2 to 3 years after the start year.`,
          });
        }
      }
    }

    const duplicate = await Batch.findOne({
      faculty: facultyExists._id,
      startYear,
    });

    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `A batch for ${facultyExists.code} starting in ${startYear} already exists.`,
      });
    }

    const newBatch = new Batch({
      faculty: facultyExists._id,
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
        select: '_id name code type totalSemestersOrYears'
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
