import express from "express";
import mongoose from "mongoose";
import SemesterOrYear from "./sem-model.js";
import Faculty from "../faculty/faculty-model.js";

const semesterRouter = express.Router();

// GET ALL
semesterRouter.get("/semesterOrYear", async (req, res) => {
  try {
    const semesters = await SemesterOrYear.find().populate("faculty courses");
    res.json({ success: true, semesters });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET BY ID
semesterRouter.get("/semesterOrYear/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findById(req.params.id).populate("faculty courses");
    if (!semester) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, semester });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// CREATE
semesterRouter.post("/semesterOrYear", async (req, res) => {
  try {
    const { faculty, semesterNumber, yearNumber, description } = req.body;

    const facultyDoc = await Faculty.findById(faculty);
    if (!facultyDoc) {
      return res.status(400).json({ success: false, message: "Invalid faculty." });
    }

    const type = facultyDoc.type;
    const number = type === "semester" ? semesterNumber : yearNumber;
    const fieldKey = type === "semester" ? "semesterNumber" : "yearNumber";

    if (!number || number < 1 || number > facultyDoc.totalSemestersOrYears) {
      return res.status(400).json({
        success: false,
        message: `Number must be between 1 and ${facultyDoc.totalSemestersOrYears}`,
      });
    }

    const existing = await SemesterOrYear.findOne({ faculty, [fieldKey]: number });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `A ${type} with number ${number} already exists for this faculty.`,
      });
    }

    const { name, slug } = generateNameAndSlug(facultyDoc.code.trim().toLowerCase(), number, type);

    const newSemester = new SemesterOrYear({
      faculty,
      semesterNumber: type === "semester" ? number : undefined,
      yearNumber: type === "yearly" ? number : undefined,
      description,
      courses: [], // <== FORCE EMPTY on creation
      name,
      slug,
    });

    await newSemester.save();
    const populated = await SemesterOrYear.findById(newSemester._id).populate("faculty courses");
    res.status(201).json({ success: true, semesterOrYear: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// UPDATE
semesterRouter.patch("/semesterOrYear/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }

  try {
    const sem = await SemesterOrYear.findById(id).populate("faculty");
    if (!sem || !sem.faculty) {
      return res.status(404).json({ success: false, message: "Semester or Year not found." });
    }

    const faculty = sem.faculty;
    const type = faculty.type;

    if (req.body.description !== undefined) sem.description = req.body.description;
    if (req.body.courses !== undefined) sem.courses = req.body.courses;

    if (type === "semester" && req.body.semesterNumber !== undefined) {
      const number = req.body.semesterNumber;
      if (number < 1 || number > faculty.totalSemestersOrYears) {
        return res.status(400).json({
          success: false,
          message: `semesterNumber must be between 1 and ${faculty.totalSemestersOrYears}`,
        });
      }
      const exists = await SemesterOrYear.findOne({ 
        _id: { $ne: id }, 
        faculty: faculty._id, 
        semesterNumber: number 
      });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: `Semester number ${number} already exists for this faculty.`,
        });
      }
      sem.semesterNumber = number;
      sem.yearNumber = undefined;
    }

    if (type === "yearly" && req.body.yearNumber !== undefined) {
      const number = req.body.yearNumber;
      if (number < 1 || number > faculty.totalSemestersOrYears) {
        return res.status(400).json({
          success: false,
          message: `yearNumber must be between 1 and ${faculty.totalSemestersOrYears}`,
        });
      }
      const exists = await SemesterOrYear.findOne({ 
        _id: { $ne: id }, 
        faculty: faculty._id, 
        yearNumber: number 
      });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: `Year number ${number} already exists for this faculty.`,
        });
      }
      sem.yearNumber = number;
      sem.semesterNumber = undefined;
    }

    const number = type === "semester" ? sem.semesterNumber : sem.yearNumber;
    if (number) {
      const { name, slug } = generateNameAndSlug(faculty.code.trim().toLowerCase(), number, type);
      sem.name = name;
      sem.slug = slug;
    }

    await sem.save();
    const populated = await SemesterOrYear.findById(id).populate("faculty courses");
    res.status(200).json({ success: true, semesterOrYear: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE
semesterRouter.delete("/semesterOrYear/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findByIdAndDelete(req.params.id);
    if (!semester) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, message: "Deleted." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Utility functions
function getOrdinalSuffix(n) {
  if (typeof n !== "number") return "";
  const j = n % 10, k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function generateNameAndSlug(facultyCode, number, type) {
  const suffix = getOrdinalSuffix(number);
  if (type === "semester") {
    return {
      name: `${number}${suffix} Semester ${facultyCode}`,
      slug: `${number}_sem_${facultyCode}`,
    };
  } else {
    return {
      name: `${number}${suffix} Year ${facultyCode}`,
      slug: `${number}_year_${facultyCode}`,
    };
  }
}

export default semesterRouter;
