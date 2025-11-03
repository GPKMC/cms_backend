import express from 'express';
import { HfInference } from '@huggingface/inference';
import Reference from '../plagiarism/websiteRef-model.js';
import AssignmentSubmissionModel from './assignmentSubmission-model.js';
import questionSubmissionModel from '../question/questionSubmission-model.js';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';
import multer from 'multer';
import fsExtra from 'fs-extra';
import path from 'path';
import { extractTextFromFile } from '../utils/fileExtract.js';
import { cosineSimilarity } from '../utils/cosine-similarity.js';
import dotenv from 'dotenv';
import groupSubmissionModel from './groupSubmission-model.js';
import assignmentModel from './assignmentModel.js';

dotenv.config();
const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

const uploadPath = path.join(process.cwd(), 'uploads', 'assignmentSubmission');
fsExtra.ensureDirSync(uploadPath);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

const assignmentSubmissionrouter = express.Router();

/* ----------------------- helpers: chunk & vectors ----------------------- */
function chunkByWords(text, wordsPerChunk = 20, stride = 10, minChars = 40) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const chunks = [];
  if (!words.length) return chunks;
  for (let i = 0; i < words.length; i += stride) {
    const piece = words.slice(i, i + wordsPerChunk).join(' ');
    if (piece.length >= minChars) chunks.push(piece);
    if (i + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

// mean-pool if the model returns token-level vectors
function ensure1D(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return [];
  if (Array.isArray(vec[0])) {
    const rows = vec.length;
    const cols = Array.isArray(vec[0]) ? vec[0].length : 0;
    if (!cols) return [];
    const out = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) {
      const row = vec[r];
      for (let c = 0; c < cols; c++) out[c] += (+row[c] || 0);
    }
    for (let c = 0; c < cols; c++) out[c] /= rows;
    return out;
  }
  return vec;
}

function l2normalize(vec) {
  const v = Array.from(vec || []);
  let n2 = 0;
  for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
  const n = Math.sqrt(n2) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
  return v;
}

/* --------------------- embedding (overlap + normalize) ------------------ */
async function generateChunkEmbeddings(text, batchSize = 16) {
  const lines = chunkByWords(text, 20);
  const chunkEmbeddings = [];

  for (let i = 0; i < lines.length; i += batchSize) {
    const batchLines = lines.slice(i, i + batchSize).map(line => line.slice(0, 4096));
    try {
      const out = await hf.featureExtraction({
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        inputs: batchLines,
      });
      if (Array.isArray(out)) {
        out.forEach((emb, idx) => {
          const pooled = ensure1D(emb);
          const norm = l2normalize(pooled);
          chunkEmbeddings.push({
            lineNumber: i + idx + 1,
            text: batchLines[idx],
            embedding: norm,
          });
        });
      }
    } catch (err) {
      console.error(`Error generating embedding for batch starting at line ${i + 1}:`, err.message);
    }
  }
  return chunkEmbeddings;
}

/* ---------------- comparator: dimension guards + normalize ------------- */
function safeNormalize(v) {
  if (!Array.isArray(v) || v.length === 0) return [];
  let n2 = 0; for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
  if (n2 > 0.99 && n2 < 1.01) return v;
  return l2normalize(v);
}

function compareChunkEmbeddings(sourceChunks, targetChunks, thresh = 0.75) {
  const matches = [];
  for (const sourceChunk of sourceChunks) {
    const a0 = sourceChunk?.embedding;
    if (!Array.isArray(a0) || a0.length === 0) continue;
    const a = safeNormalize(a0);

    for (const targetChunk of targetChunks) {
      const b0 = Array.isArray(targetChunk?.embedding) ? targetChunk.embedding : targetChunk;
      if (!Array.isArray(b0) || b0.length === 0) continue;
      if (a.length !== b0.length) continue;

      const b = safeNormalize(b0);
      const sim = cosineSimilarity(a, b);

      if (sim > thresh) {
        matches.push({
          lineNumber: sourceChunk.lineNumber,
          similarity: sim,
          matchedText: sourceChunk.text,
          sourceText: targetChunk.text ?? null,
        });
      }
    }
  }
  return matches;
}

/* ---------------------- flatten for schema (CRITICAL) ------------------- */
function flattenForSchema(matchGroups = []) {
  const out = [];

  // 1) Correctly read enum values from subdocument array schema
  let allowedSourceTypes = [];
  try {
    const detailsPath = AssignmentSubmissionModel.schema.path('plagiarismDetails');
    // detailsPath is a DocumentArray; get its inner schema
    const detailsSchema = detailsPath?.schema;
    const stPath = detailsSchema?.path('sourceType');
    allowedSourceTypes = Array.isArray(stPath?.enumValues) ? stPath.enumValues : [];
    console.log('[plagiarismDetails.sourceType] allowed enum =', allowedSourceTypes);
  } catch (e) {
    console.log('[flattenForSchema] could not read enum values:', e?.message);
  }

  // 2) Fallback default if we can’t introspect (keeps you safe from validation fails)
  const DEFAULT_ENUM = ['assignment', 'group', 'question', 'reference'];
  const enumList = allowedSourceTypes.length ? allowedSourceTypes : DEFAULT_ENUM;

  // 3) Normalize our internal labels to the schema’s enum
  function normalizeSourceType(internalTag) {
    const tag = String(internalTag || '').toLowerCase();

    // map to canonical short tokens first
    let canonical;
    if (tag.includes('group')) canonical = 'group';
    else if (tag.includes('question')) canonical = 'question';
    else if (tag.includes('assign')) canonical = 'assignment';
    else canonical = 'reference';

    // if canonical exists in actual enum, use it; otherwise, safest first enum
    return enumList.includes(canonical) ? canonical : enumList[0];
  }

  function pickSourceId(g) {
    return (
      g.sourceId ||
      g.assignment?._id ||
      g.question?._id ||
      g.matchedGroup?._id ||
      g.matchedStudent?._id ||
      g.referenceId ||
      g.source?._id ||
      null
    );
  }

  for (const g of (matchGroups || [])) {
    const sourceType = normalizeSourceType(g.type);
    const srcId = pickSourceId(g);

    for (const m of (g.matches || [])) {
      out.push({
        sourceType,                         // ✅ guaranteed to be in enum
        sourceId: srcId,                    // ✅ required
        similarity: Number(m.similarity ?? 0),
        matchedText: m.matchedText ?? '',
        sourceText: m.sourceText ?? null,
        lineNumber: m.lineNumber ?? null,
        meta: {
          assignmentId: g.assignment?._id ?? null,
          questionId: g.question?._id ?? null,
          matchedStudentId: g.matchedStudent?._id ?? null,
          matchedGroupId: g.matchedGroup?._id ?? null,
          referenceTitle: g.referenceTitle ?? null,
        },
      });
    }
  }
  return out;
}

/* ================================ ROUTE ================================ */
assignmentSubmissionrouter.post(
  '/assignment-submission',
  upload.array('files'),
  authmiddleware,
  authorizedRole('student'),
  async (req, res) => {
    try {
      const { assignment, student } = req.body;
      const assignmentDoc = await assignmentModel
        .findById(assignment)
        .select('acceptingSubmissions closeAt');

      if (!assignmentDoc) {
        return res.status(404).json({ error: 'Assignment not found.' });
      }
      if (assignmentDoc.acceptingSubmissions === false) {
        return res.status(403).json({ error: 'This assignment is not accepting submissions' });
      }
      if (assignmentDoc.closeAt && new Date() > new Date(assignmentDoc.closeAt)) {
        return res.status(403).json({ error: 'The submission deadline has passed' });
      }

      const files = req.files || [];
      let combinedText = req.body.combinedText || '';

      console.log('Received submission POST:');
      console.log('Assignment ID:', assignment);
      console.log('Student ID:', student);
      console.log('Files received:', files.length);
      console.log('Initial combinedText length:', combinedText.length);

      const filesMeta = [];
      for (const file of files) {
        try {
          const text = await extractTextFromFile(file.path, file.mimetype);
          filesMeta.push({
            url: `/uploads/assignmentSubmission/${file.filename}`,
            originalname: file.originalname,
            filetype: file.mimetype,
            extractedText: text || '',
          });
          if (text && text.trim()) combinedText += '\n' + text;
          console.log(`Extracted text from file ${file.originalname} length:`, text ? text.length : 0);
        } catch (e) {
          console.error('File extraction error:', file.originalname, e.message);
          filesMeta.push({
            url: `/uploads/assignmentSubmission/${file.filename}`,
            originalname: file.originalname,
            filetype: file.mimetype,
            extractedText: '',
          });
        }
      }

      console.log('Final combinedText length after extraction:', combinedText.length);

      const existingSubmission = await AssignmentSubmissionModel.findOne({ assignment, student });
      if (existingSubmission) {
        console.log('Submission rejected: already submitted by student.');
        return res.status(409).json({
          error: 'You have already submitted this assignment.',
          plagiarismPercentage: existingSubmission.plagiarismPercentage || 0,
          matches: existingSubmission.plagiarismDetails || [],
        });
      }

      const chunkEmbeddings = await generateChunkEmbeddings(combinedText);
      console.log('Generated chunk embeddings count:', chunkEmbeddings.length);
      if (chunkEmbeddings.length === 0) {
        console.log('No embeddings generated - aborting');
        return res.status(400).json({ error: 'Could not generate embeddings.' });
      }

      const otherSubmissions = await AssignmentSubmissionModel.find({
        student: { $ne: student },
        'chunkEmbeddings.0': { $exists: true },
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
            },
          },
        });

      console.log('Other assignment submissions fetched for plagiarism check:', otherSubmissions.length);

      const groupSubmissions = await groupSubmissionModel.find()
        .select('chunkEmbeddings groupId submittedBy combinedText groupAssignmentId')
        .populate('submittedBy', 'username')
        .populate({
          path: 'groupAssignmentId',
          select: 'title courseInstance',
          populate: {
            path: 'courseInstance',
            select: 'course',
            populate: {
              path: 'course',
              select: 'name code',
            },
          },
        });

      console.log('Group submissions fetched:', groupSubmissions.length);

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
            },
          },
        });
      console.log('Question submissions fetched:', questionSubmissions.length);

      const references = await Reference.find({ embedding: { $exists: true, $ne: [] } })
        .select('embedding title type text');
      console.log('References fetched:', references.length);

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
      console.log('Assignment submission plagiarism match groups:', matches.length);

      for (const sub of groupSubmissions) {
        if (!sub.chunkEmbeddings) continue;
        const subMatches = compareChunkEmbeddings(chunkEmbeddings, sub.chunkEmbeddings);
        if (subMatches.length > 0) {
          matches.push({
            type: 'group-assignment-submission',
            sourceId: sub._id,
            matchedGroup: { _id: sub.groupId?._id, name: sub.groupId?.name },
            matchedStudent: { _id: sub.submittedBy._id, username: sub.submittedBy.username },
            assignment: {
              _id: sub.groupAssignmentId?._id,
              title: sub.groupAssignmentId?.title,
              courseName: sub.groupAssignmentId?.courseInstance?.course?.name,
              courseCode: sub.groupAssignmentId?.courseInstance?.course?.code,
            },
            matches: subMatches,
          });
        }
      }
      console.log('After group submissions check, total match groups:', matches.length);

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
      console.log('After question submissions check, total match groups:', matches.length);

      if (matches.length === 0) {
        for (const ref of references) {
          if (!ref.embedding) continue;

          const targetChunks =
            Array.isArray(ref.embedding) && Array.isArray(ref.embedding[0])
              ? ref.embedding.map((v, i) => ({
                  lineNumber: i + 1,
                  text: ref.title || null,
                  embedding: l2normalize(ensure1D(v)),
                }))
              : (ref.embedding || []);

          if (!targetChunks?.length) continue;

          const refMatches = compareChunkEmbeddings(chunkEmbeddings, targetChunks);
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
      console.log('After reference check, total match groups:', matches.length);

      const _flat = matches.flatMap(g => g.matches || []);
      const _hi = _flat.filter(m => m.similarity >= 0.85).length;
      const _med = _flat.filter(m => m.similarity >= 0.75 && m.similarity < 0.85).length;
      console.log(`Similarity bands: HIGH>=0.85=${_hi}, MED>=0.75=${_med}, total=${_flat.length}`);

      function aggregateCoverage(sourceChunks, matchGroups) {
        const HIGH = 0.85, MED = 0.75;
        const bestByLine = new Map();
        for (const g of (matchGroups || [])) {
          for (const m of (g.matches || [])) {
            const prev = bestByLine.get(m.lineNumber) ?? 0;
            if (m.similarity > prev) bestByLine.set(m.lineNumber, m.similarity);
          }
        }
        let high = 0, med = 0;
        for (const s of (sourceChunks || [])) {
          const sim = bestByLine.get(s.lineNumber) ?? 0;
          if (sim >= HIGH) high++;
          else if (sim >= MED) med++;
        }
        const n = sourceChunks?.length || 1;
        return Math.min(1, (high + 0.5 * med) / n);
      }

      const coverage = aggregateCoverage(chunkEmbeddings, matches);
      const plagiarismPercentage = +(coverage * 100).toFixed(2);
      console.log('Coverage:', coverage, '=> plagiarismPercentage:', plagiarismPercentage);

      const plagiarismDetailsForSave = flattenForSchema(matches);
      if (plagiarismDetailsForSave.length) {
        console.log('[plagiarismDetails sample row]', plagiarismDetailsForSave[0]);
      }

      if (plagiarismPercentage >= 30) {
        console.log('Submission rejected due to plagiarism threshold');
        return res.status(200).json({
          status: 'PLAGIARIZED',
          message: `Submission rejected. Plagiarism detected at ${plagiarismPercentage.toFixed(2)}%.`,
          plagiarismPercentage,
          matches: plagiarismDetailsForSave,
          accepted: false,
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
        plagiarismDetails: plagiarismDetailsForSave,   // ✅ enum-safe
        submittedAt: new Date(),
        status: 'submitted',
      });

      await newSubmission.save();
      console.log('Submission saved successfully with ID:', newSubmission._id);

      return res.status(201).json({
        status: 'ACCEPTED',
        plagiarismPercentage,
        matches: plagiarismDetailsForSave,
        message: 'Submission saved and checked for plagiarism.',
        submission: newSubmission,
      });

    } catch (err) {
      console.error('Error in assignment submission route:', err);
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
