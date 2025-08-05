import express from 'express';
import { HfInference } from '@huggingface/inference';
import AssignmentSubmissionModel from './AssignmentSubmission-model.js';
import Reference from '../plagiarism/websiteRef-model.js';
import questionSubmissionModel from '../question/questionSubmission-model.js';
import groupSubmission from './groupSubmission-model.js';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';
import multer from 'multer';
import fsExtra from "fs-extra";
import path from "path";
import { extractTextFromFile } from '../utlis/fileExtract.js';
import { cosineSimilarity } from '../utlis/cosine-similarity.js';
import dotenv from "dotenv";
dotenv.config();
const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

const uploadPath = path.join(process.cwd(), ".uploads", "assignmentSubmission");
fsExtra.ensureDirSync(uploadPath);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

const assignmentSubmissionrouter = express.Router();

function chunkByWords(text, wordsPerChunk = 20) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  return chunks;
}

async function generateChunkEmbeddings(text, batchSize = 16) {
  // NEW: chunk by fixed word count
  const lines = chunkByWords(text, 20); // 20 words per chunk is a good default
  const chunkEmbeddings = [];

  for (let i = 0; i < lines.length; i += batchSize) {
    const batchLines = lines.slice(i, i + batchSize).map(line => line.slice(0, 4096));
    try {
      const embeddings = await hf.featureExtraction({
        model: "sentence-transformers/all-MiniLM-L6-v2",
        inputs: batchLines,
      });
      if (Array.isArray(embeddings)) {
        embeddings.forEach((embedding, idx) => {
          chunkEmbeddings.push({
            lineNumber: i + idx + 1,
            text: batchLines[idx],
            embedding,
          });
        });
      }
    } catch (err) {
      console.error(`Error generating embedding for batch starting at line ${i + 1}:`, err.message);
    }
  }
  return chunkEmbeddings;
}

assignmentSubmissionrouter.post(
  '/assignment-submission',
  upload.array("files"),
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { assignment, student } = req.body;
      const files = req.files || [];
      let combinedText = req.body.combinedText || "";

      console.log("Received submission POST:");
      console.log("Assignment ID:", assignment);
      console.log("Student ID:", student);
      console.log("Files received:", files.length);
      console.log("Initial combinedText length:", combinedText.length);

      const filesMeta = [];
      for (const file of files) {
        try {
          const text = await extractTextFromFile(file.path, file.mimetype);
          filesMeta.push({
            url: `/uploads/assignmentSubmission/${file.filename}`,
            originalname: file.originalname,
            filetype: file.mimetype,
            extractedText: text || ""
          });
          if (text && text.trim()) combinedText += "\n" + text;
          console.log(`Extracted text from file ${file.originalname} length:`, text ? text.length : 0);
        } catch (e) {
          console.error("File extraction error:", file.originalname, e.message);
          filesMeta.push({
            url: `/uploads/assignmentSubmission/${file.filename}`,
            originalname: file.originalname,
            filetype: file.mimetype,
            extractedText: ""
          });
        }
      }

      console.log("Final combinedText length after extraction:", combinedText.length);

      const existingSubmission = await AssignmentSubmissionModel.findOne({ assignment, student });
      if (existingSubmission) {
        console.log("Submission rejected: already submitted by student.");
        return res.status(409).json({
          error: "You have already submitted this assignment.",
          plagiarismPercentage: existingSubmission.plagiarismPercentage || 0,
          matches: existingSubmission.plagiarismDetails || []
        });
      }


      const chunkEmbeddings = await generateChunkEmbeddings(combinedText);
      console.log("Generated chunk embeddings count:", chunkEmbeddings.length);
      if (chunkEmbeddings.length === 0) {
        console.log("No embeddings generated - aborting");
        return res.status(400).json({ error: 'Could not generate embeddings.' });
      }

    const otherSubmissions = await AssignmentSubmissionModel.find({
  assignment,
  student: { $ne: student }
})
  .select('chunkEmbeddings student combinedText assignment')
  .populate('student', 'username')
  .populate({
    path: 'assignment',
    select: 'title courseInstance',
    populate: {
      path: 'courseInstance',
      select: 'course',
      populate: {
        path: 'course',
        select: 'name code',
      }
    }
  });

      console.log("Other assignment submissions fetched for plagiarism check:", otherSubmissions.length);

    const groupSubmissions = await groupSubmission.find()
  .select('chunkEmbeddings groupId submittedBy combinedText assignment')
  .populate('groupId', 'name')
  .populate('submittedBy', 'username')
  .populate({
    path: 'assignment',
    select: 'title courseInstance',
    populate: {
      path: 'courseInstance',
      select: 'course',
      populate: {
        path: 'course',
        select: 'name code',
      }
    }
  });

      console.log("Group submissions fetched:", groupSubmissions.length);

const questionSubmissions = await questionSubmissionModel.find()
  .select('chunkEmbeddings student answerText question')
  .populate('student', 'username')
  .populate({
    path: 'question',
    select: 'title courseInstance',
    populate: {
      path: 'courseInstance',
      select: 'course',
      populate: {
        path: 'course',
        select: 'name code',
      }
    }
  });
      console.log("Question submissions fetched:", questionSubmissions.length);

      const references = await Reference.find({ embedding: { $exists: true, $ne: [] } }).select('embedding title type text');
      console.log("References fetched:", references.length);

    function compareChunkEmbeddings(sourceChunks, targetChunks) {
  const matches = [];
  for (const sourceChunk of sourceChunks) {
    for (const targetChunk of targetChunks) {
      if (!sourceChunk.embedding || !targetChunk.embedding) continue;
      const sim = cosineSimilarity(sourceChunk.embedding, targetChunk.embedding);
      // ADD LOG HERE
      console.log(`Comparing chunk: [${sourceChunk.text}] VS [${targetChunk.text}] SIMILARITY: ${sim}`);
      if (sim > 0.75) {
        matches.push({
          lineNumber: sourceChunk.lineNumber,
          similarity: sim,
          matchedText: sourceChunk.text,
          sourceText: targetChunk.text,
        });
      }
    }
  }
  return matches;
}

      let matches = [];

    for (const sub of otherSubmissions) {
  if (!sub.chunkEmbeddings) continue;
  const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
  if (subMatches.length > 0) {
    matches.push({
      type: 'assignment-submission',
      sourceId: sub._id,
      matchedStudent: { _id: sub.student._id, username: sub.student.username },
      assignment: {
        _id: sub.assignment._id,
        title: sub.assignment.title,
        courseName: sub.assignment.courseInstance?.course?.name,
        courseCode: sub.assignment.courseInstance?.course?.code,
      },
      matches: subMatches,
    });
  }
}
      console.log("Assignment submission plagiarism match groups:", matches.length);

  for (const sub of groupSubmissions) {
  if (!sub.chunkEmbeddings) continue;
  const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
  if (subMatches.length > 0) {
    matches.push({
      type: 'group-assignment-submission',
      sourceId: sub._id,
      matchedGroup: { _id: sub.groupId._id, name: sub.groupId.name },
      matchedStudent: { _id: sub.submittedBy._id, username: sub.submittedBy.username },
      assignment: {
        _id: sub.assignment._id,
        title: sub.assignment.title,
        courseName: sub.assignment.courseInstance?.course?.name,
        courseCode: sub.assignment.courseInstance?.course?.code,
      },
      matches: subMatches,
    });
  }
}
      console.log("After group submissions check, total match groups:", matches.length);

 for (const sub of questionSubmissions) {
  if (!sub.chunkEmbeddings) continue;
  const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
  if (subMatches.length > 0) {
    matches.push({
      type: 'question-submission',
      sourceId: sub._id,
      matchedStudent: { _id: sub.student._id, username: sub.student.username },
      question: {
        _id: sub.question._id,
        title: sub.question.title,
        courseName: sub.question.courseInstance?.course?.name,
        courseCode: sub.question.courseInstance?.course?.code,
      },
      matches: subMatches,
    });
  }
}
      console.log("After question submissions check, total match groups:", matches.length);

      if (matches.length === 0) {
        for (const ref of references) {
          if (!ref.embedding) continue;
          const refMatches = compareChunkEmbeddings(chunkEmbeddings, ref.embedding);

          if (refMatches.length > 0) {
            matches.push({
              type: 'reference',
              sourceId: ref._id,
              referenceTitle: ref.title,
              matches: refMatches,
            });
          }
        }
      }
      console.log("After reference check, total match groups:", matches.length);

      let maxSimilarity = 0;
      if (Array.isArray(matches)) {
        matches.forEach(matchGroup => {
          if (matchGroup && Array.isArray(matchGroup.matches)) {
            matchGroup.matches.forEach(m => {
              if (m && typeof m.similarity === 'number' && !isNaN(m.similarity)) {
                if (m.similarity > maxSimilarity) maxSimilarity = m.similarity;
              }
            });
          }
        });
      }

      const plagiarismPercentage = maxSimilarity * 100;
      console.log("Max similarity:", maxSimilarity, "=> plagiarismPercentage:", plagiarismPercentage);

      if (plagiarismPercentage >= 30) {
        console.log("Submission rejected due to plagiarism threshold");
        return res.status(200).json({
          status: "PLAGIARIZED",
          message: `Submission rejected. Plagiarism detected at ${plagiarismPercentage.toFixed(2)}%.`,
          plagiarismPercentage,
          matches,
          accepted: false
        });

      }

      const newSubmission = new AssignmentSubmissionModel({
        assignment,
        student,
        files: filesMeta,
        combinedText,
        chunkEmbeddings,
        isFlagged: plagiarismPercentage > 0,
        plagiarismPercentage,
        plagiarismDetails: matches,
        submittedAt: new Date(),
        status: "submitted"
      });

      await newSubmission.save();
      console.log("Submission saved successfully with ID:", newSubmission._id);

      return res.status(201).json({
        status: "ACCEPTED",
        plagiarismPercentage,
        matches,
        message: "Submission saved and checked for plagiarism.",
        submission: newSubmission,
      });

    } catch (err) {
      console.error("Error in assignment submission route:", err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  }
);


// DELETE /assignment-submission/:submissionId/unsubmit
assignmentSubmissionrouter.delete('/:submissionId/unsubmit', authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const studentId = req.user._id; // Assuming you set req.user in your authmiddleware

    const submission = await AssignmentSubmissionModel.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    // Only the owner/student can unsubmit
    if (submission.student.toString() !== studentId.toString()) {
      return res.status(403).json({ error: 'You are not authorized to unsubmit this assignment.' });
    }

    await AssignmentSubmissionModel.deleteOne({ _id: submissionId });

    return res.status(200).json({ message: 'Submission unsubmitted (deleted) successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});
// GET /assignment-submission/:submissionId
assignmentSubmissionrouter.get('/:submissionId', authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const studentId = req.user._id; // Provided by authmiddleware

    const submission = await AssignmentSubmissionModel.findById(submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    // Only the owner/student can view
    if (submission.student.toString() !== studentId.toString()) {
      return res.status(403).json({ error: 'You are not authorized to view this submission.' });
    }

    return res.status(200).json({ submission });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});
// GET /assignment-submission/by-assignment/:assignmentId
assignmentSubmissionrouter.get('/by-assignment/:assignmentId/submission', authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const studentId = req.user._id; // From authmiddleware

    const submission = await AssignmentSubmissionModel.findOne({
      assignment: assignmentId,
      student: studentId
    });

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    return res.status(200).json({ submission });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default assignmentSubmissionrouter;
