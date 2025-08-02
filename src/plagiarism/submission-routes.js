import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";

const Submissionrouter = express.Router();

// Multer storage config for dynamic folder by assignment type
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const assignmentType = req.body.assignment_type || "default";
    const uploadPath = path.join(process.cwd(), ".uploads", `${assignmentType}Submission`);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

// POST /api/submit-assignment
Submissionrouter.post("/submit-assignment", upload.array("files"), async (req, res) => {
  try {
    const { student_id, text_input, assignment_type } = req.body;

    if (!student_id) {
      return res.status(400).json({ error: "student_id is required" });
    }

    // Prepare form-data to send to FastAPI plagiarism API
    const form = new FormData();

    // Append files from multer
    for (const file of req.files) {
      form.append("files", fs.createReadStream(file.path), file.originalname);
    }

    form.append("student_id", student_id);

    if (text_input) {
      form.append("text_input", text_input);
    }

    if (assignment_type) {
      form.append("assignment_type", assignment_type);
    }

    // Call FastAPI plagiarism endpoint
    const response = await axios.post("http://localhost:8000/check-plagiarism", form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    // OPTIONAL: Cleanup uploaded files after sending to FastAPI
    for (const file of req.files) {
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting temp file:", file.path, err);
      });
    }

    // Return the plagiarism check result to frontend
    return res.json(response.data);
  } catch (error) {
    console.error("Error in submit-assignment:", error.message || error);
    return res.status(500).json({ error: "Failed to process submission" });
  }
});

export default Submissionrouter;
