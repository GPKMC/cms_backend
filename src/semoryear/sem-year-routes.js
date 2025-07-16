import mongoose from "mongoose";
import express from "express";
import SemesterOrYear from "./sem-model.js";
import Batch from "../batch/batch-model.js";
import Faculty from "../faculty/faculty-model.js";

const semesterRouter = express.Router();

const semesterNameToNumber = {
  "First Semester": 1,
  "Second Semester": 2,
  "Third Semester": 3,
  "Fourth Semester": 4,
  "Fifth Semester": 5,
  "Sixth Semester": 6,
  "Seventh Semester": 7,
  "Eighth Semester": 8,
};
const numberToSemesterName = [
  "",
  "First Semester",
  "Second Semester",
  "Third Semester",
  "Fourth Semester",
  "Fifth Semester",
  "Sixth Semester",
  "Seventh Semester",
  "Eighth Semester",
];

// Helper to compute status based on dates
function getStatusByDate(startDate, endDate) {
  const now = new Date();
  if (!startDate) return "not_started";
  if (now < startDate) return "not_started";
  if (!endDate) return "ongoing";
  if (now > endDate) return "completed";
  return "ongoing";
}

// GET all semesters or years
semesterRouter.get("/semesterOrYear", async (req, res) => {
  try {
    const {
      limit = 20,
      search,
      facultyType,
      isCompleted,
      facultyCode,
      programLevel,
      batch,        // add batch filter here
    } = req.query;

    const query = {};
    let facultyIds = null;

    // Filter by status
    if (isCompleted !== undefined) {
      if (isCompleted === "true") {
        query.status = "completed";
      } else {
        query.status = { $in: ["not_started", "ongoing"] };
      }
    }

    // Build faculty filters
    const facultyFilter = {};
    if (programLevel) {
      facultyFilter.programLevel = programLevel;
    }
    if (facultyType === "semester" || facultyType === "yearly") {
      facultyFilter.type = facultyType;
    }
    if (facultyCode) {
      facultyFilter.code = { $regex: `^${facultyCode.trim()}$`, $options: "i" };
    }

    if (Object.keys(facultyFilter).length > 0) {
      const matchedFaculties = await Faculty.find(facultyFilter).select("_id");
      facultyIds = matchedFaculties.map((f) => f._id);
      query.faculty = { $in: facultyIds };
    }

    // Filter by batch id if provided
    if (batch) {
      query.batch = batch;
    }

    // Global search: search by semester/year name, batch name, faculty code/name
    if (search) {
      const searchRegex = { $regex: search, $options: "i" };

      const matchedFaculties = await Faculty.find({
        $or: [{ name: searchRegex }, { code: searchRegex }],
      }).select("_id");
      const searchFacultyIds = matchedFaculties.map((f) => f._id);

      query.$or = [
        { name: searchRegex },
        { slug: searchRegex },
        { description: searchRegex },
        { faculty: { $in: searchFacultyIds } },
        // You can also implement batch name search here by querying batches if needed
      ];
    }

    const limitNum = Number(limit) || 20;

    const semesters = await SemesterOrYear.find(query)
      .populate({
        path: "faculty",
        select: "_id name code type programLevel totalSemestersOrYears",
      })
      .populate({
        path: "batch",
        select: "_id batchname startYear",
      })
      .populate({
        path: "courses",
        select: "name",
      })
      .sort({ createdAt: -1 })
      .limit(limitNum);

    const totalCount = await SemesterOrYear.countDocuments(query);

    const numberToSemesterName = [
      "",
      "First Semester",
      "Second Semester",
      "Third Semester",
      "Fourth Semester",
      "Fifth Semester",
      "Sixth Semester",
      "Seventh Semester",
      "Eighth Semester",
    ];

    const formatted = semesters.map((sem) => ({
      _id: sem._id,
      semesterName: sem.semesterNumber
        ? numberToSemesterName[sem.semesterNumber]
        : sem.yearNumber
        ? `Year ${sem.yearNumber}`
        : "",
      faculty: sem.faculty ? sem.faculty.code : "",
      facultyName: sem.faculty ? sem.faculty.name : "",
      batch: sem.batch ? sem.batch.batchname : "",
      batchStartYear: sem.batch ? sem.batch.startYear : null,
      startDate: sem.startDate,
      endDate: sem.endDate,
      courses: Array.isArray(sem.courses) ? sem.courses.map((c) => c.name) : [],
      status: sem.status || "not_started",
    }));

    res.json({ success: true, semesters: formatted, totalCount });
  } catch (error) {
    console.error("Error fetching semesters:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});



// GET semester/year by ID
semesterRouter.get("/semesterOrYear/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findById(req.params.id).populate(
      "faculty batch courses"
    );
    if (!semester)
      return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, semester });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create semester or year (single or bulk)
semesterRouter.post("/semesterOrYear", async (req, res) => {
  try {
    const payload = req.body;

    // Helper to process one semester object
    const processSemester = async (item) => {
      const {
        faculty,
        batch,
        semesterNumber,
        semesterName,
        yearNumber,
        startDate,
        description,
        courses,
      } = item;

      // Find faculty and batch documents
      const facultyDoc = await Faculty.findById(faculty);
      const batchDoc = await Batch.findById(batch);

      if (!facultyDoc || !batchDoc) {
        throw new Error("Invalid faculty or batch.");
      }

      // Ensure batch belongs to faculty
      if (batchDoc.faculty.toString() !== facultyDoc._id.toString()) {
        throw new Error("Batch does not belong to the specified faculty.");
      }

      // Validate startDate is not in the past
      if (startDate) {
        const today = new Date();
        // Reset time for today to 00:00:00 to only compare dates
        today.setHours(0, 0, 0, 0);

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);

        if (start < today) {
          throw new Error("Start date cannot be in the past.");
        }
      }

      // Support "semesterName" as alternative to semesterNumber
      let number = semesterNumber;
      if (!number && semesterName) number = semesterNameToNumber[semesterName];

      // Validate number based on faculty type
      if (
        facultyDoc.type === "semester" &&
        (!number || number > facultyDoc.totalSemestersOrYears)
      ) {
        throw new Error(
          `Semester number must be between 1 and ${facultyDoc.totalSemestersOrYears}.`
        );
      }
      if (
        facultyDoc.type === "yearly" &&
        (!yearNumber || yearNumber > facultyDoc.totalSemestersOrYears)
      ) {
        throw new Error(
          `Year number must be between 1 and ${facultyDoc.totalSemestersOrYears}.`
        );
      }

      // Generate name and slug based on batch startYear, faculty code, number, and type
      const { name, slug } = generateNameAndSlug(
        batchDoc.startYear,
        facultyDoc.code.trim().toLowerCase(),
        number || yearNumber,
        facultyDoc.type
      );

      // Check for duplicate name or slug before saving
      const existing = await SemesterOrYear.findOne({
        $or: [{ name }, { slug }],
        faculty,
        batch,
      });
      if (existing) {
        throw new Error("Semester/Year with the same name or slug already exists.");
      }

      // Create new SemesterOrYear document
      const newSemester = new SemesterOrYear({
        faculty,
        batch,
        semesterNumber: facultyDoc.type === "semester" ? number : undefined,
        yearNumber: facultyDoc.type === "yearly" ? yearNumber : undefined,
        description,
        courses,
        startDate,
        slug,
        name,
        status: "not_started",  // explicitly set default status here (optional)
      });

      await newSemester.save();

      // Return populated document
      return SemesterOrYear.findById(newSemester._id).populate(
        "faculty batch courses"
      );
    };

    // Support bulk array or single object
    if (Array.isArray(payload)) {
      const promises = payload.map((item) => processSemester(item));
      const results = await Promise.all(promises);
      return res.status(201).json({ success: true, semesters: results });
    }

    const result = await processSemester(payload);
    res.status(201).json({ success: true, semesterOrYear: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});


// PATCH update semester or year by ID
semesterRouter.patch("/semesterOrYear/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid semester/year ID." });
  }

  try {
    const sem = await SemesterOrYear.findById(id).populate("faculty batch");
    if (!sem) {
      return res.status(404).json({ success: false, message: "Semester or Year not found." });
    }

    if (!sem.faculty || !sem.batch) {
      return res.status(400).json({ success: false, message: "Faculty or Batch reference missing or invalid." });
    }

    // Prevent changes to faculty or batch references via PATCH
    if (req.body && "faculty" in req.body) delete req.body.faculty;
    if (req.body && "batch" in req.body) delete req.body.batch;

    const faculty = sem.faculty;
    const batch = sem.batch;

    // Update other fields safely
    if (req.body.description !== undefined) sem.description = req.body.description;
    if (req.body.courses !== undefined) sem.courses = req.body.courses;

    // Update semesterNumber or yearNumber based on faculty type
    if (faculty.type === "semester") {
      if (req.body.semesterNumber !== undefined) {
        if (
          req.body.semesterNumber < 1 ||
          req.body.semesterNumber > faculty.totalSemestersOrYears
        ) {
          return res.status(400).json({
            success: false,
            message: `semesterNumber must be between 1 and ${faculty.totalSemestersOrYears}`,
          });
        }
        sem.semesterNumber = req.body.semesterNumber;
        sem.yearNumber = undefined;
      }
    } else {
      if (req.body.yearNumber !== undefined) {
        if (
          req.body.yearNumber < 1 ||
          req.body.yearNumber > faculty.totalSemestersOrYears
        ) {
          return res.status(400).json({
            success: false,
            message: `yearNumber must be between 1 and ${faculty.totalSemestersOrYears}`,
          });
        }
        sem.yearNumber = req.body.yearNumber;
        sem.semesterNumber = undefined;
      }
    }

    // Handle status update explicitly from admin
    if (req.body.status !== undefined) {
      if (!["not_started", "ongoing", "completed"].includes(req.body.status)) {
        return res.status(400).json({ success: false, message: "Invalid status value." });
      }
      sem.status = req.body.status;

      // If status is completed, ensure endDate is at least today or later
      if (sem.status === "completed") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (!sem.endDate || sem.endDate < today) {
          sem.endDate = today;
        }
      }
    }

    // Validate startDate: cannot be in the past
    if (req.body.startDate) {
      const newStartDate = new Date(req.body.startDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0); // normalize time for comparison

      if (newStartDate < today) {
        return res.status(400).json({
          success: false,
          message: "Start date cannot be in the past.",
        });
      }

      sem.startDate = newStartDate;

      // Calculate endDate exactly based on faculty type only if status is not completed
      if (sem.status !== "completed") {
        const monthsToAdd = faculty.type === "semester" ? 6 : 12;
        const calculatedEndDate = new Date(sem.startDate);
        calculatedEndDate.setMonth(calculatedEndDate.getMonth() + monthsToAdd);
        sem.endDate = calculatedEndDate;
      }
    }

    // If startDate not updated but exists and status is not completed, ensure correct endDate gap
    if (!req.body.startDate && sem.startDate && sem.status !== "completed") {
      const monthsToAdd = faculty.type === "semester" ? 6 : 12;
      const expectedEndDate = new Date(sem.startDate);
      expectedEndDate.setMonth(expectedEndDate.getMonth() + monthsToAdd);

      if (!sem.endDate || sem.endDate.getTime() !== expectedEndDate.getTime()) {
        sem.endDate = expectedEndDate;
      }
    }

    // Regenerate name and slug if semesterNumber/yearNumber changed or startYear changes
    const number = faculty.type === "semester" ? sem.semesterNumber : sem.yearNumber;
    if (number) {
      const { name, slug } = generateNameAndSlug(
        batch.startYear,
        faculty.code.trim().toLowerCase(),
        number,
        faculty.type
      );
      sem.name = name;
      sem.slug = slug;

      // Check duplicates on update (exclude current doc)
      const duplicate = await SemesterOrYear.findOne({
        _id: { $ne: sem._id },
        $or: [{ name }, { slug }],
        faculty: faculty._id,
        batch: batch._id,
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: "Duplicate semester/year name or slug exists." });
      }
    }

    await sem.save();

    const populated = await SemesterOrYear.findById(id).populate("faculty batch courses");

    res.status(200).json({ success: true, semesterOrYear: populated });
  } catch (error) {
    console.error("Error in semester update:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE semester or year by ID
semesterRouter.delete("/semesterOrYear/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findByIdAndDelete(req.params.id);
    if (!semester)
      return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, message: "Deleted." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Helper functions

function getOrdinalSuffix(n) {
  if (typeof n !== "number") return "";
  const j = n % 10,
    k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function generateNameAndSlug(batchStartYear, facultyCode, number, type) {
  const suffix = getOrdinalSuffix(number);
  if (type === "semester") {
    return {
      name: `${batchStartYear} ${number}${suffix} Semester ${facultyCode}`,
      slug: `${batchStartYear}_${number}_sem_${facultyCode}`,
    };
  } else {
    return {
      name: `${batchStartYear} ${number}${suffix} Year ${facultyCode}`,
      slug: `${batchStartYear}_${number}_year_${facultyCode}`,
    };
  }
}

export default semesterRouter;
