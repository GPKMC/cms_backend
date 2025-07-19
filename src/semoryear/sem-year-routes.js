// routes/sem-router.js

import mongoose from "mongoose";
import express from "express";
import Faculty from "../faculty/faculty-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import SemesterOrYear from "./sem-model.js";

const semesterRouter = express.Router();

// GET all semesters/years (template)
semesterRouter.get("/semesterOrYear", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const {
      limit = 20,
      faculty,
      semesterNumber,
      yearNumber,
      search,
      programLevel,
      facultyType,
      facultyCode,
    } = req.query;

    const query = {};

    // Faculty filter
    if (faculty) query.faculty = faculty;
    if (semesterNumber) query.semesterNumber = semesterNumber;
    if (yearNumber) query.yearNumber = yearNumber;

    // Faculty search
    const facultyFilter = {};
    if (programLevel) facultyFilter.programLevel = programLevel;
    if (facultyType) facultyFilter.type = facultyType;
    if (facultyCode) facultyFilter.code = { $regex: `^${facultyCode.trim()}$`, $options: "i" };

    if (Object.keys(facultyFilter).length) {
      const facs = await Faculty.find(facultyFilter).select("_id");
      query.faculty = { $in: facs.map(f => f._id) };
    }

    // Global search
    if (search) {
      const searchRegex = { $regex: search, $options: "i" };
      query.$or = [
        { name: searchRegex },
        { slug: searchRegex },
        { description: searchRegex },
      ];
    }

    const semesters = await SemesterOrYear.find(query)
      .populate("faculty", "_id name code type programLevel totalSemestersOrYears")
      .populate("courses", "name code")
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    const totalCount = await SemesterOrYear.countDocuments(query);

    res.json({ success: true, semesters, totalCount });
  } catch (error) {
    console.error("Error fetching semesters:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET semester/year by ID
semesterRouter.get("/semesterOrYear/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findById(req.params.id)
      .populate("faculty", "_id name code type programLevel")
      .populate("courses", "name code");
    if (!semester)
      return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, semester });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create semester/year (template, not batch-specific)
// POST create semester/year (template, not batch-specific)
semesterRouter.post("/semesterOrYear", authmiddleware, authorizedRole("admin"), async (req, res) => {
  try {
    const { faculty, semesterNumber, yearNumber, description, courses } = req.body;

    // Validate faculty and type
    const facultyDoc = await Faculty.findById(faculty);
    if (!facultyDoc) return res.status(400).json({ success: false, message: "Invalid faculty." });

    // Strict validation
    if (facultyDoc.type === "semester") {
      if (!semesterNumber || yearNumber) {
        return res.status(400).json({
          success: false,
          message: "For semester-based faculty, you must provide semesterNumber only (not yearNumber)."
        });
      }
    } else if (facultyDoc.type === "yearly") {
      if (!yearNumber || semesterNumber) {
        return res.status(400).json({
          success: false,
          message: "For yearly faculty, you must provide yearNumber only (not semesterNumber)."
        });
      }
    }

    // Only one definition per faculty + number
    const duplicate = await SemesterOrYear.findOne({
      faculty,
      ...(facultyDoc.type === "semester" && { semesterNumber }),
      ...(facultyDoc.type === "yearly" && { yearNumber }),
    });
    if (duplicate) {
      return res.status(400).json({ success: false, message: "Semester/Year definition already exists." });
    }

    // Create
    const semester = new SemesterOrYear({ faculty, semesterNumber, yearNumber, description, courses });
    await semester.save();

    const populated = await SemesterOrYear.findById(semester._id)
      .populate("faculty", "_id name code type programLevel")
      .populate("courses", "name code");

    res.status(201).json({ success: true, semester: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// PATCH update semester/year (template)
semesterRouter.patch("/semesterOrYear/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const sem = await SemesterOrYear.findById(req.params.id).populate("faculty");
    if (!sem) return res.status(404).json({ success: false, message: "Not found." });

    // Strict validation on update
    if (sem.faculty.type === "semester") {
      if (req.body.yearNumber) {
        return res.status(400).json({
          success: false,
          message: "Cannot set yearNumber for semester-based faculty. Use semesterNumber."
        });
      }
      if (req.body.semesterNumber !== undefined) sem.semesterNumber = req.body.semesterNumber;
    }
    if (sem.faculty.type === "yearly") {
      if (req.body.semesterNumber) {
        return res.status(400).json({
          success: false,
          message: "Cannot set semesterNumber for yearly faculty. Use yearNumber."
        });
      }
      if (req.body.yearNumber !== undefined) sem.yearNumber = req.body.yearNumber;
    }

    if (req.body.description !== undefined) sem.description = req.body.description;
    if (req.body.courses !== undefined) sem.courses = req.body.courses;

    await sem.save();

    const populated = await SemesterOrYear.findById(sem._id)
      .populate("faculty", "_id name code type programLevel")
      .populate("courses", "name code");

    res.json({ success: true, semester: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});


// DELETE semester/year
semesterRouter.delete("/semesterOrYear/:id", authmiddleware, authorizedRole("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const deleted = await SemesterOrYear.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, message: "Deleted." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default semesterRouter;
