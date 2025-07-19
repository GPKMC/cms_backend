import express from "express";
import mongoose from "mongoose";

import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import BatchPeriod from "./batchPeriod-model.js";

const routBatchPeriodRouter = express.Router();

// CREATE BatchPeriod
routBatchPeriodRouter.post('/batchPeriod', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { batch, semesterOrYear, startDate, endDate, status, description } = req.body;

    // Validation: required fields
    if (!batch || !semesterOrYear) {
      return res.status(400).json({ message: "Missing required fields: batch, semesterOrYear." });
    }

    // Get batch and semesterOrYear docs
    const batchDoc = await mongoose.model("Batch").findById(batch);
    const sy = await mongoose.model("SemesterOrYear").findById(semesterOrYear);
    if (!batchDoc) return res.status(400).json({ message: "Batch not found." });
    if (!sy) return res.status(400).json({ message: "SemesterOrYear not found." });

    // Ensure both point to the same faculty
    if (String(batchDoc.faculty) !== String(sy.faculty)) {
      return res.status(400).json({ message: "Batch and SemesterOrYear do not belong to the same faculty." });
    }

    // Date range validation
    let type;
    if (sy.semesterNumber) type = "semester";
    else if (sy.yearNumber) type = "year";
    else return res.status(400).json({ message: "SemesterOrYear must have either semesterNumber or yearNumber." });

    // Helper: Calendar month difference
    function monthsDiff(start, end) {
      return (
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth())
      );
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const diffMonths = monthsDiff(start, end);

      // Semester: 6-7 months (inclusive)
      if (type === "semester") {
        if (diffMonths < 6) {
          return res.status(400).json({ message: "Semester must be at least 6 months long." });
        }
        if (diffMonths > 7) {
          return res.status(400).json({ message: "Semester cannot be longer than 7 months." });
        }
      }
      // Year: 12-13 months (inclusive)
      else if (type === "year") {
        if (diffMonths < 12) {
          return res.status(400).json({ message: "Year must be at least 12 months long." });
        }
        if (diffMonths > 13) {
          return res.status(400).json({ message: "Year cannot be longer than 13 months." });
        }
      }

      // Batch year range validation
      if (batchDoc.startYear && start.getFullYear() < batchDoc.startYear) {
        return res.status(400).json({ message: "startDate cannot be earlier than batch start year." });
      }
      if (batchDoc.endYear) {
        if (end.getFullYear() > batchDoc.endYear) {
          return res.status(400).json({ message: "endDate cannot be after batch end year." });
        }
        if (start.getFullYear() > batchDoc.endYear) {
          return res.status(400).json({ message: "startDate cannot be after batch end year." });
        }
      }
    }

    // Check duplicate
    const exists = await BatchPeriod.findOne({ batch, semesterOrYear });
    if (exists) return res.status(400).json({ message: "BatchPeriod already exists for this batch and semester/year." });

    const batchPeriod = new BatchPeriod({ batch, semesterOrYear, startDate, endDate, status, description });
    await batchPeriod.save();

    const populated = await BatchPeriod.findById(batchPeriod._id)
      .populate("batch")
      .populate({
        path: "semesterOrYear",
        populate: { path: "courses", select: "name code" }
      });

    res.status(201).json({ message: "BatchPeriod created", batchPeriod: populated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});




// GET all BatchPeriods (optional filters)
routBatchPeriodRouter.get('/batchPeriod', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { batch, faculty, semesterOrYear, status } = req.query;
    const query = {};
    if (batch) query.batch = batch;
    if (semesterOrYear) query.semesterOrYear = semesterOrYear;
    if (status) query.status = status;

    // If you want to filter by faculty, do it after population
    let list = await BatchPeriod.find(query)
      .populate({
        path: "batch",
        populate: { path: "faculty", select: "name code" } // Only if you want batch.faculty info
      })
      .populate({
        path: "semesterOrYear",
        populate: { path: "courses", select: "name code" }
      })
      .sort({ startDate: 1 });

    // Filter by faculty if provided (based on batch or semesterOrYear)
    if (faculty) {
      list = list.filter(
        bp =>
          (bp.batch && String(bp.batch.faculty) === String(faculty)) ||
          (bp.semesterOrYear && String(bp.semesterOrYear.faculty) === String(faculty))
      );
    }

    res.json({ batchPeriods: list });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET single BatchPeriod by ID
routBatchPeriodRouter.get('/batchPeriod/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }
  try {
    const period = await BatchPeriod.findById(req.params.id)
      .populate("batch") 
        .populate({
    path: "batch",
    populate: { path: "faculty" } // <-- populate faculty inside batch
  })// If you want, you can also deep-populate batch.faculty here
      .populate({
        path: "semesterOrYear",
        populate: { path: "courses", select: "name code" }
      });
    if (!period) return res.status(404).json({ message: "Not found" });
    res.json({ batchPeriod: period });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// UPDATE BatchPeriod
routBatchPeriodRouter.patch('/batchPeriod/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }
  try {
    const bp = await BatchPeriod.findById(req.params.id);
    if (!bp) return res.status(404).json({ message: "Not found" });

    // Load related docs if needed
    const batchDoc = await mongoose.model("Batch").findById(bp.batch);
    if (!batchDoc) return res.status(400).json({ message: "Batch not found." });

    // Only allow updating status, dates, description (NOT semesterOrYear)
    const allowed = ['startDate', 'endDate', 'status', 'description'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        bp[k] = req.body[k];
      }
    }

    // Date range validation
    let type;
    const syDoc = await mongoose.model("SemesterOrYear").findById(bp.semesterOrYear);
    if (syDoc.semesterNumber) type = "semester";
    else if (syDoc.yearNumber) type = "year";
    else return res.status(400).json({ message: "SemesterOrYear must have either semesterNumber or yearNumber." });

    // Helper: calendar months difference function
    function monthsDiff(start, end) {
      return (
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth())
      );
    }

    if (bp.startDate && bp.endDate) {
      const start = new Date(bp.startDate);
      const end = new Date(bp.endDate);
      const diffMonths = monthsDiff(start, end);

      if (type === "semester") {
        if (diffMonths < 6) {
          return res.status(400).json({ message: "Semester must be at least 6 months long." });
        }
        if (diffMonths > 7) {
          return res.status(400).json({ message: "Semester cannot be longer than 7 months." });
        }
      } else if (type === "year") {
        if (diffMonths < 12) {
          return res.status(400).json({ message: "Year must be at least 12 months long." });
        }
        if (diffMonths > 13) {
          return res.status(400).json({ message: "Year cannot be longer than 13 months." });
        }
      }

      // Batch year range validation
      if (batchDoc.startYear && start.getFullYear() < batchDoc.startYear) {
        return res.status(400).json({ message: "startDate cannot be earlier than batch start year." });
      }
      if (batchDoc.endYear) {
        if (end.getFullYear() > batchDoc.endYear) {
          return res.status(400).json({ message: "endDate cannot be after batch end year." });
        }
        if (start.getFullYear() > batchDoc.endYear) {
          return res.status(400).json({ message: "startDate cannot be after batch end year." });
        }
      }
    }

    await bp.save();

    const populated = await BatchPeriod.findById(bp._id)
      .populate("batch")
      .populate({
        path: "semesterOrYear",
        populate: { path: "courses", select: "name code" }
      });

    res.json({ message: "BatchPeriod updated", batchPeriod: populated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



// DELETE BatchPeriod
routBatchPeriodRouter.delete('/batchPeriod/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }
  try {
    const deleted = await BatchPeriod.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET batch periods by batch slug
routBatchPeriodRouter.get('/batchPeriod/by-batch/:id', authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const batch = await mongoose.model("Batch").findById(req.params.id);
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    const periods = await BatchPeriod.find({ batch: batch._id })
      .populate("batch")
      .populate({
        path: "semesterOrYear",
        populate: { path: "courses", select: "name code" }
      });

    res.json({ batchPeriods: periods });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


export default routBatchPeriodRouter;
