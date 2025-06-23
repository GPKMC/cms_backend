import mongoose from "mongoose";
import express from "express";
import Faculty from "../faculty/faculty-model.js";
import SemesterOrYear from "./sem-model.js";


const semesterRouter = express.Router();

// Create semester/year
semesterRouter.post("/semesterOrYear", async (req, res) => {
    try {
        const { faculty, semesterNumber, yearNumber, description } = req.body;

        if (!faculty) {
            return res.status(400).json({ success: false, message: "Faculty is required." });
        }

        const facultyExists = await Faculty.findById(faculty);
        if (!facultyExists) {
            return res.status(400).json({ success: false, message: "Faculty does not exist." });
        }

        if (facultyExists.type === "semester") {
            if (!semesterNumber) {
                return res.status(400).json({ success: false, message: "semesterNumber is required for semester-based faculties." });
            }

            if (semesterNumber > facultyExists.totalSemestersOrYears) {
                return res.status(400).json({
                    success: false,
                    message: `This faculty only allows ${facultyExists.totalSemestersOrYears} semesters.`,
                });
            }

            const existing = await SemesterOrYear.findOne({ faculty, semesterNumber });
            if (existing) {
                return res.status(400).json({
                    success: false,
                    message: `Semester number ${semesterNumber} already exists for this faculty.`,
                });
            }
        }

        if (facultyExists.type === "yearly") {
            if (!yearNumber) {
                return res.status(400).json({ success: false, message: "yearNumber is required for yearly faculties." });
            }

            if (yearNumber > facultyExists.totalSemestersOrYears) {
                return res.status(400).json({
                    success: false,
                    message: `This faculty only allows ${facultyExists.totalSemestersOrYears} years.`,
                });
            }

            const existing = await SemesterOrYear.findOne({ faculty, yearNumber });
            if (existing) {
                return res.status(400).json({
                    success: false,
                    message: `Year number ${yearNumber} already exists for this faculty.`,
                });
            }
        }

        const newSemOrYear = new SemesterOrYear({
            faculty,
            semesterNumber,
            yearNumber,
            description,
        });

        await newSemOrYear.save();

        const populatedEntry = await SemesterOrYear.findById(newSemOrYear._id).populate("faculty courses");

        res.status(201).json({ success: true, message: "Semester/Year created successfully", semesterOrYear: populatedEntry });
    } catch (error) {
        console.error("Error creating semester/year:", error);
        res.status(500).json({ success: false, message: "Server error creating semester/year." });
    }
});
semesterRouter.patch('/semesterOrYear/:id', async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid semester/year ID." });
  }

  try {
    const semesterOrYear = await SemesterOrYear.findById(id);
    if (!semesterOrYear) {
      return res.status(404).json({ success: false, message: "Semester/Year not found." });
    }

    // Check if client tries to change faculty - forbid it
    if (req.body.faculty && req.body.faculty !== String(semesterOrYear.faculty)) {
      return res.status(400).json({ success: false, message: "Changing faculty is not allowed." });
    }

    const facultyId = semesterOrYear.faculty?.toString();
    if (!facultyId) {
      return res.status(400).json({ success: false, message: "Faculty ID missing for this semester/year." });
    }

    const faculty = await Faculty.findById(facultyId);
    if (!faculty) {
      return res.status(400).json({ success: false, message: "Faculty not found." });
    }

    // Validate and update semesterNumber or yearNumber based on faculty.type
    if (faculty.type === 'semester') {
      const semesterNumber = req.body.semesterNumber !== undefined
        ? Number(req.body.semesterNumber)
        : semesterOrYear.semesterNumber;

      if (!semesterNumber || isNaN(semesterNumber)) {
        return res.status(400).json({ success: false, message: "Valid semesterNumber is required for semester-based faculties." });
      }
      if (semesterNumber > faculty.totalSemestersOrYears) {
        return res.status(400).json({ success: false, message: `Max allowed semesters: ${faculty.totalSemestersOrYears}.` });
      }

      const duplicate = await SemesterOrYear.findOne({
        faculty: facultyId,
        semesterNumber,
        _id: { $ne: id }
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: `Semester number ${semesterNumber} already exists for this faculty.` });
      }

      semesterOrYear.semesterNumber = semesterNumber;
      semesterOrYear.yearNumber = undefined; // clear yearNumber if any

    } else if (faculty.type === 'yearly') {
      const yearNumber = req.body.yearNumber !== undefined
        ? Number(req.body.yearNumber)
        : semesterOrYear.yearNumber;

      if (!yearNumber || isNaN(yearNumber)) {
        return res.status(400).json({ success: false, message: "Valid yearNumber is required for yearly faculties." });
      }
      if (yearNumber > faculty.totalSemestersOrYears) {
        return res.status(400).json({ success: false, message: `Max allowed years: ${faculty.totalSemestersOrYears}.` });
      }

      const duplicate = await SemesterOrYear.findOne({
        faculty: facultyId,
        yearNumber,
        _id: { $ne: id }
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: `Year number ${yearNumber} already exists for this faculty.` });
      }

      semesterOrYear.yearNumber = yearNumber;
      semesterOrYear.semesterNumber = undefined; // clear semesterNumber if any

    } else {
      return res.status(400).json({ success: false, message: "Unknown faculty type." });
    }

    // Update description if provided
    if (req.body.description !== undefined) {
      semesterOrYear.description = req.body.description;
    }

    // Update courses if provided and is an array
    if (req.body.courses !== undefined) {
      if (Array.isArray(req.body.courses)) {
        semesterOrYear.courses = req.body.courses;
      } else {
        return res.status(400).json({ success: false, message: "Courses must be an array of course IDs." });
      }
    }

    // Regenerate name and slug based on faculty.code and updated semester/year number
    regenerateNameAndSlug(semesterOrYear, faculty);

    await semesterOrYear.save();

    const updatedEntry = await SemesterOrYear.findById(id).populate("faculty courses");

    res.status(200).json({
      success: true,
      message: "Semester/Year updated successfully.",
      semesterOrYear: updatedEntry,
    });

  } catch (error) {
    console.error("Error updating semester/year:", error);
    res.status(500).json({ success: false, message: "Server error updating semester/year." });
  }
});

function regenerateNameAndSlug(semesterOrYear, faculty) {
  const facultyCode = faculty.code.trim();
  const facultySlug = facultyCode.toLowerCase().replace(/\s+/g, "_");

  if (faculty.type === "semester") {
    semesterOrYear.name = `${facultyCode} ${semesterOrYear.semesterNumber}${getOrdinalSuffix(semesterOrYear.semesterNumber)} Semester`;
    semesterOrYear.slug = `${facultySlug}_${semesterOrYear.semesterNumber}_sem`;
  } else {
    semesterOrYear.name = `${facultyCode} ${semesterOrYear.yearNumber}${getOrdinalSuffix(semesterOrYear.yearNumber)} Year`;
    semesterOrYear.slug = `${facultySlug}_${semesterOrYear.yearNumber}_year`;
  }
}

function getOrdinalSuffix(n) {
  if (typeof n !== 'number') return '';
  const j = n % 10,
    k = n % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}


// Delete semester/year by ID
semesterRouter.delete("/semesterOrYear/:id", async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    try {
        const deletedEntry = await SemesterOrYear.findByIdAndDelete(id);
        if (!deletedEntry) {
            return res.status(404).json({ success: false, message: "Semester/Year not found." });
        }

        res.status(200).json({ success: true, message: "Semester/Year deleted successfully", semesterOrYear: deletedEntry });
    } catch (error) {
        console.error("Error deleting semester/year:", error);
        res.status(500).json({ success: false, message: "Server error deleting semester/year." });
    }
});

export default semesterRouter;
