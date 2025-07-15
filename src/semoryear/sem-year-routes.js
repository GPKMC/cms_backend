import mongoose from "mongoose";
import SemesterOrYear from "./sem-model.js";
import Batch from "../batch/batch-model.js";
import Faculty from "../faculty/faculty-model.js";


const semesterRouter = express.Router();

// ✅ GET ALL
semesterRouter.get("/semesterOrYear", async (req, res) => {
  try {
    const semesters = await SemesterOrYear.find().populate("faculty batch courses");
    res.json({ success: true, semesters });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ GET BY ID
semesterRouter.get("/semesterOrYear/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID." });
  }
  try {
    const semester = await SemesterOrYear.findById(req.params.id).populate("faculty batch courses");
    if (!semester) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, semester });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ POST (CREATE)
semesterRouter.post("/semesterOrYear", async (req, res) => {
  try {
    const { faculty, batch, semesterNumber, yearNumber, startDate, description, courses } = req.body;
    const facultyDoc = await Faculty.findById(faculty);
    const batchDoc = await Batch.findById(batch);

    if (!facultyDoc || !batchDoc) return res.status(400).json({ success: false, message: "Invalid faculty or batch." });

    let number = facultyDoc.type === "semester" ? semesterNumber : yearNumber;
    if (!number || number > facultyDoc.totalSemestersOrYears)
      return res.status(400).json({ success: false, message: `Number must be between 1 and ${facultyDoc.totalSemestersOrYears}.` });

    const { name, slug } = generateNameAndSlug(batchDoc.startYear, facultyDoc.code.trim().toLowerCase(), number, facultyDoc.type);

    const newSemester = new SemesterOrYear({
      faculty,
      batch,
      semesterNumber: facultyDoc.type === "semester" ? semesterNumber : undefined,
      yearNumber: facultyDoc.type === "yearly" ? yearNumber : undefined,
      description,
      courses,
      startDate,
      slug,
      name,
    });

    await newSemester.save();
    const populated = await SemesterOrYear.findById(newSemester._id).populate("faculty batch courses");
    res.status(201).json({ success: true, semesterOrYear: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

//put

function getOrdinalSuffix(n) {
  if (typeof n !== "number") return "";
  const j = n % 10, k = n % 100;
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

    // Remove faculty and batch from req.body if present, so no change is made to those fields
    if (`${sem.faculty}` in req.body) delete req.body.sem.faculty;
    if ("batch" in req.body) delete req.body.batch;

    const faculty = sem.faculty;
    const batch = sem.batch;

    // Update other fields safely
    if (req.body.description !== undefined) sem.description = req.body.description;
    if (req.body.courses !== undefined) sem.courses = req.body.courses;

    // Update semesterNumber or yearNumber based on faculty type
    if (faculty.type === "semester") {
      if (req.body.semesterNumber !== undefined) {
        if (req.body.semesterNumber < 1 || req.body.semesterNumber > faculty.totalSemestersOrYears) {
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
        if (req.body.yearNumber < 1 || req.body.yearNumber > faculty.totalSemestersOrYears) {
          return res.status(400).json({
            success: false,
            message: `yearNumber must be between 1 and ${faculty.totalSemestersOrYears}`,
          });
        }
        sem.yearNumber = req.body.yearNumber;
        sem.semesterNumber = undefined;
      }
    }

    // Update startDate if provided
    if (req.body.startDate) {
      sem.startDate = new Date(req.body.startDate);

      // Calculate endDate exactly based on faculty type
      const monthsToAdd = faculty.type === "semester" ? 6 : 12;
      const calculatedEndDate = new Date(sem.startDate);
      calculatedEndDate.setMonth(calculatedEndDate.getMonth() + monthsToAdd);
      sem.endDate = calculatedEndDate;
    }

    // If startDate not updated but exists, ensure correct endDate gap
    if (!req.body.startDate && sem.startDate) {
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
    }

    // Update isCompleted based on endDate
    sem.isCompleted = sem.endDate && sem.endDate < new Date();

    await sem.save();

    const populated = await SemesterOrYear.findById(id).populate("faculty batch courses");

    res.status(200).json({ success: true, semesterOrYear: populated });
  } catch (error) {
    console.error("Error in semester update:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});



// ✅ DELETE
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

export default semesterRouter;
