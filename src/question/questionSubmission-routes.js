import express from 'express';
import { HfInference } from '@huggingface/inference';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';
import { cosineSimilarity } from '../utlis/cosine-similarity.js';
import dotenv from 'dotenv';
import questionSubmissionModel from './questionSubmission-model.js';
import AssignmentSubmissionModel from '../assignment/AssignmentSubmission-model.js';
import groupSubmissionModel from '../assignment/groupSubmission-model.js';
import Reference from "../plagiarism/websiteRef-model.js";
dotenv.config();

const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);
const questionSubmissionRouter = express.Router();

function chunkByWords(text, wordsPerChunk = 20) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  return chunks;
}

async function generateChunkEmbeddings(text, batchSize = 16) {
  const lines = chunkByWords(text, 20);
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

// Helper to count words in a string
function countWords(str) {
  return str.split(/\s+/).filter(Boolean).length;
}

questionSubmissionRouter.post(
  '/',
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { question, student, answerText } = req.body;
      if (!answerText || answerText.trim().length === 0) {
        return res.status(400).json({ error: "Answer text is required." });
      }

      console.log("Received question submission:");
      console.log("Question ID:", question);
      console.log("Student ID:", student);
      console.log("AnswerText length:", answerText.length);

      // Prevent duplicate submission (optional, adjust if needed)
      const existingSubmission = await questionSubmissionModel.findOne({ question, student, status: "submitted" });
      if (existingSubmission) {
        return res.status(409).json({
          error: "You have already submitted this question.",
          plagiarismPercentage: existingSubmission.plagiarismPercentage || 0,
          matches: existingSubmission.plagiarismDetails || []
        });
      }

      // Generate chunk embeddings from answerText
      const chunkEmbeddings = await generateChunkEmbeddings(answerText);
      if (chunkEmbeddings.length === 0) {
        return res.status(400).json({ error: 'Could not generate embeddings.' });
      }

      // Fetch all existing submissions for plagiarism check:
      // Assignment submissions excluding this student
      const otherAssignmentSubs = await AssignmentSubmissionModel.find({
        student: { $ne: student }
      }).select('chunkEmbeddings student combinedText assignment');

      // Group assignment submissions
      const groupSubs = await groupSubmissionModel.find()
        .select('chunkEmbeddings groupId submittedBy combinedText assignment');

      // Question submissions excluding current student
      const otherQuestionSubs = await questionSubmissionModel.find({
        student: { $ne: student }
      }).select('chunkEmbeddings student answerText question');

      // References
      const references = await Reference.find({ embedding: { $exists: true, $ne: [] } }).select('embedding title type text');

      // Compare embeddings helper
      function compareChunkEmbeddings(sourceChunks, targetChunks) {
        const matches = [];
        for (const sourceChunk of sourceChunks) {
          for (const targetChunk of targetChunks) {
            if (!sourceChunk.embedding || !targetChunk.embedding) continue;
            const sim = cosineSimilarity(sourceChunk.embedding, targetChunk.embedding);
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

      // Compare with other assignment submissions
      for (const sub of otherAssignmentSubs) {
        if (!sub.chunkEmbeddings) continue;
        const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
        if (subMatches.length > 0) {
          matches.push({
            type: 'assignment-submission',
            sourceId: sub._id,
            matchedStudent: sub.student,
            assignment: sub.assignment,
            matches: subMatches,
          });
        }
      }

      // Compare with group submissions
      for (const sub of groupSubs) {
        if (!sub.chunkEmbeddings) continue;
        const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
        if (subMatches.length > 0) {
          matches.push({
            type: 'group-assignment-submission',
            sourceId: sub._id,
            matchedGroup: sub.groupId,
            matchedStudent: sub.submittedBy,
            assignment: sub.assignment,
            matches: subMatches,
          });
        }
      }

      // Compare with other question submissions
      for (const sub of otherQuestionSubs) {
        if (!sub.chunkEmbeddings) continue;
        const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
        if (subMatches.length > 0) {
          matches.push({
            type: 'question-submission',
            sourceId: sub._id,
            matchedStudent: sub.student,
            question: sub.question,
            matches: subMatches,
          });
        }
      }

      // If no matches, compare with references
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

      // Calculate total words in submitted answerText
      const submittedTotalWords = countWords(answerText);

      // For each matched group, calculate total matched words & total words in matched document
      matches.forEach(group => {
        // Total words in matched chunks from submission side (matchedText)
        const matchedWords = group.matches.reduce((sum, m) => sum + countWords(m.matchedText || ""), 0);

        // Total words in the target text (sourceText) aggregated over all matches
        const targetWords = group.matches.reduce((sum, m) => sum + countWords(m.sourceText || ""), 0);

        group.matchedWords = matchedWords;
        group.targetWords = targetWords;

        // Percentage of matched words in submitted text for this group
        group.matchedWordsPercentOfSubmission = submittedTotalWords > 0 ? (matchedWords / submittedTotalWords) * 100 : 0;

        // Percentage of matched words relative to target text size
        group.matchedWordsPercentOfTarget = targetWords > 0 ? (matchedWords / targetWords) * 100 : 0;
      });

      // Calculate average similarity as before
      let totalSimilarity = 0;
      let count = 0;
      if (Array.isArray(matches)) {
        matches.forEach(matchGroup => {
          if (matchGroup && Array.isArray(matchGroup.matches)) {
            matchGroup.matches.forEach(m => {
              if (m && typeof m.similarity === 'number' && !isNaN(m.similarity)) {
                totalSimilarity += m.similarity;
                count++;
              }
            });
          }
        });
      }
      const averageSimilarity = count > 0 ? (totalSimilarity / count) : 0;
      const plagiarismPercentage = averageSimilarity * 100;

      // Also compute overall matched words across all matches
      const totalMatchedWords = matches.reduce((sum, g) => sum + (g.matchedWords || 0), 0);
      const totalTargetWords = matches.reduce((sum, g) => sum + (g.targetWords || 0), 0);

      const overallMatchedWordsPercentOfSubmission = submittedTotalWords > 0 ? (totalMatchedWords / submittedTotalWords) * 100 : 0;
      const overallMatchedWordsPercentOfTargets = totalTargetWords > 0 ? (totalMatchedWords / totalTargetWords) * 100 : 0;
if (plagiarismPercentage >= 30) {
  console.log("Plagiarism detected, returning result:", {
    status: "PLAGIARIZED",
    plagiarismPercentage,
    averageSimilarity,
    matches,
    submittedTotalWords,
    totalMatchedWords,
    totalTargetWords,
    overallMatchedWordsPercentOfSubmission,
    overallMatchedWordsPercentOfTargets,
    accepted: false
  });

  return res.status(200).json({
    status: "PLAGIARIZED",
    message: `Submission rejected. Plagiarism detected at ${plagiarismPercentage.toFixed(2)}%.`,
    plagiarismPercentage,
    averageSimilarity,
    matches,
    submittedTotalWords,
    totalMatchedWords,
    totalTargetWords,
    overallMatchedWordsPercentOfSubmission,
    overallMatchedWordsPercentOfTargets,
    accepted: false
  });
}


      // Save submission
      const submissionDoc = new questionSubmissionModel({
        question,
        student,
        answerText,
        chunkEmbeddings,
        isFlagged: plagiarismPercentage > 0,
        plagiarismPercentage,
        plagiarismDetails: matches,
        submittedAt: new Date(),
        status: "submitted",
      });

      await submissionDoc.save();

      return res.status(201).json({
        status: "ACCEPTED",
        plagiarismPercentage,
        averageSimilarity,
        matches,
        submittedTotalWords,
        totalMatchedWords,
        totalTargetWords,
        overallMatchedWordsPercentOfSubmission,
        overallMatchedWordsPercentOfTargets,
        message: "Question submission saved and checked for plagiarism.",
        submission: submissionDoc,
        accepted: true
      });
      

    } catch (error) {
      console.error("Error in question submission route:", error);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  }
);



questionSubmissionRouter.delete('/:submissionId/unsubmit', authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const studentId = req.user._id; // Assuming you set req.user in your authmiddleware

    const submission = await questionSubmissionModel.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    // Only the owner/student can unsubmit
    if (submission.student.toString() !== studentId.toString()) {
      return res.status(403).json({ error: 'You are not authorized to unsubmit this assignment.' });
    }

    await questionSubmissionModel.deleteOne({ _id: submissionId });

    return res.status(200).json({ message: 'Submission unsubmitted (deleted) successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});
// GET /assignment-submission/:submissionId
questionSubmissionRouter.get('/:submissionId', authmiddleware, authorizedRole("student"), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const studentId = req.user._id; // Provided by authmiddleware

    const submission = await questionSubmissionModel.findById(submissionId);

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
// questionSubmissionRouter.js

questionSubmissionRouter.get(
  '/by-question/:questionId/submission',
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const { questionId } = req.params;
      const studentId = req.user._id;

      // LOG: When the endpoint is hit
      console.log("API HIT: /by-question/:questionId/submission", { questionId, studentId });

      // Try to find the submission
      const submission = await questionSubmissionModel.findOne({
        question: questionId,
        student: studentId
      });

      // LOG: Submission found or not
      if (!submission) {
        console.log("NO SUBMISSION FOUND", { questionId, studentId });
        return res.status(404).json({ error: 'Submission not found.' });
      }

      console.log("SUBMISSION FOUND:", submission);

      return res.status(200).json({ submission });
    } catch (err) {
      console.error("ERROR in /by-question/:questionId/submission:", err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  }
);


export default questionSubmissionRouter;
