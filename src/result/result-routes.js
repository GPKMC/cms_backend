// routes/result.router.js
import express from "express";
import mongoose from "mongoose";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import CourseInstance from "../course/courseinstance-model.js";
import InternalRecord from "./result-model.js";

const ResultRouter = express.Router();

/* ───────── helpers ───────── */
async function ensureTeacherOwnsCI(ciId, userId) {
  const ci = await CourseInstance.findById(ciId).select("teacher").lean();
  if (!ci) throw new Error("CourseInstance not found");
  if (String(ci.teacher) !== String(userId)) throw new Error("Forbidden");
}
function isValidObjectId(id) { return mongoose.Types.ObjectId.isValid(id); }
const clamp = (n, max) => (Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0);

/* ───────── 1) Create/Upsert a single record (teacher) ─────────
   Body (exam):
     { courseInstance, student, kind:"exam", attemptNo:1|2|3, maxMarks, marks, examTitle?, examDate?, remarks? }
   Body (practical):
     // Option A: send total
     { courseInstance, student, kind:"practical", practicalTotal, remarks? }
     // Option B: send parts (will compute total)
     { courseInstance, student, kind:"practical", pFirst?, pFinal?, pAssign?, pAttend?, remarks? }
*/
ResultRouter.post(
  "/",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { courseInstance, student, kind } = req.body;

      if (!isValidObjectId(courseInstance) || !isValidObjectId(student)) {
        return res.status(400).json({ error: "Invalid courseInstance or student id" });
      }
      await ensureTeacherOwnsCI(courseInstance, req.user._id);

      const filter = { courseInstance, student, kind };
      if (kind === "exam") filter.attemptNo = Number(req.body.attemptNo);

      const existing = await InternalRecord.findOne(filter).lean();
      if (existing?.lockedByAdmin) return res.status(403).json({ error: "Locked by admin" });

      // exam guards
      if (kind === "exam") {
        const maxMarks = Number(req.body.maxMarks);
        const marks = Number(req.body.marks);
        if (Number.isFinite(maxMarks) && Number.isFinite(marks) && marks > maxMarks) {
          return res.status(400).json({ error: "marks cannot exceed maxMarks" });
        }
      }

      // practical: compute total if parts present (default part max=5; allow override)
      let payload = { ...req.body };
      if (kind === "practical") {
        const hasParts = ["pFirst", "pFinal", "pAssign", "pAttend"].some(k => payload[k] != null);
        const maxFirst  = Number(req.body.pMaxFirst  ?? 5);
        const maxFinal  = Number(req.body.pMaxFinal  ?? 5);
        const maxAssign = Number(req.body.pMaxAssign ?? 5);
        const maxAttend = Number(req.body.pMaxAttend ?? 5);

        if (hasParts) {
          const pFirst  = clamp(Number(payload.pFirst),  maxFirst);
          const pFinal  = clamp(Number(payload.pFinal),  maxFinal);
          const pAssign = clamp(Number(payload.pAssign), maxAssign);
          const pAttend = clamp(Number(payload.pAttend), maxAttend);
          const total = pFirst + pFinal + pAssign + pAttend;

          payload = { 
            ...payload, 
            pFirst, pFinal, pAssign, pAttend, 
            practicalTotal: total 
          };
        } else if (payload.practicalTotal == null) {
          return res.status(400).json({ error: "Provide practicalTotal or any of pFirst/pFinal/pAssign/pAttend" });
        }
      }

      const doc = await InternalRecord.findOneAndUpdate(
        filter,
        { ...payload, filledBy: req.user._id },
        { upsert: true, new: true, runValidators: true }
      );
      res.json({ success: true, record: doc });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

/* ───────── 2) Bulk upsert EXAM records (teacher) ─────────
   POST /results/bulk/exam/:courseInstanceId
   Body:
     {
       attemptNo: 1|2|3,
       maxMarks: number,
       examTitle?: string,
       examDate?: string|Date,
       rows: [{ student, marks, remarks? }, ...]
     }
*/
ResultRouter.post(
  "/bulk/exam/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { courseInstanceId } = req.params;
      if (!isValidObjectId(courseInstanceId)) return res.status(400).json({ error: "Invalid courseInstance id" });
      await ensureTeacherOwnsCI(courseInstanceId, req.user._id);

      const attemptNo = Number(req.body.attemptNo);
      const maxMarks = Number(req.body.maxMarks);
      const { examTitle, examDate, rows } = req.body;

      if (![1, 2, 3].includes(attemptNo)) return res.status(400).json({ error: "attemptNo must be 1, 2, or 3" });
      if (!Number.isFinite(maxMarks) || maxMarks < 0) return res.status(400).json({ error: "maxMarks must be a non-negative number" });
      if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No rows provided" });

      const ops = [];
      for (const r of rows) {
        if (!isValidObjectId(r.student)) return res.status(400).json({ error: `Invalid student id: ${r.student}` });
        const marks = Number(r.marks);
        if (!Number.isFinite(marks) || marks < 0) return res.status(400).json({ error: "marks must be a non-negative number" });
        if (marks > maxMarks) return res.status(400).json({ error: "marks cannot exceed maxMarks" });

        ops.push({
          updateOne: {
            filter: { courseInstance: courseInstanceId, student: r.student, kind: "exam", attemptNo },
            update: {
              $set: {
                courseInstance: courseInstanceId,
                student: r.student,
                kind: "exam",
                attemptNo,
                maxMarks,
                marks,
                examTitle: examTitle || `Exam-${attemptNo}`,
                examDate: examDate || null,
                remarks: r.remarks || null,
                filledBy: req.user._id
              }
            },
            upsert: true
          }
        });
      }

      const result = await InternalRecord.bulkWrite(ops, { ordered: false });
      res.json({ success: true, result });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

/* ───────── 3) Bulk upsert PRACTICAL records (teacher) ─────────
   POST /results/bulk/practical/:courseInstanceId
   Body (either totals or parts):
     {
       // optional per-field maxima (default 5)
       pMaxFirst?: number, pMaxFinal?: number, pMaxAssign?: number, pMaxAttend?: number,
       rows: [
         // A) send parts (preferred)
         { student, pFirst?, pFinal?, pAssign?, pAttend?, remarks? }
         // B) or just the total
         { student, practicalTotal, remarks? }
       ]
     }
*/
ResultRouter.post(
  "/bulk/practical/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const { courseInstanceId } = req.params;
      if (!isValidObjectId(courseInstanceId)) return res.status(400).json({ error: "Invalid courseInstance id" });
      await ensureTeacherOwnsCI(courseInstanceId, req.user._id);

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No rows provided" });

      const maxFirst  = Number(req.body.pMaxFirst  ?? 5);
      const maxFinal  = Number(req.body.pMaxFinal  ?? 5);
      const maxAssign = Number(req.body.pMaxAssign ?? 5);
      const maxAttend = Number(req.body.pMaxAttend ?? 5);

      const ops = [];
      for (const r of rows) {
        if (!isValidObjectId(r.student)) return res.status(400).json({ error: `Invalid student id: ${r.student}` });

        const hasParts = ["pFirst","pFinal","pAssign","pAttend"].some(k => r[k] != null);
        let practicalTotal;

        let pFirst, pFinal, pAssign, pAttend;
        if (hasParts) {
          pFirst  = clamp(Number(r.pFirst),  maxFirst);
          pFinal  = clamp(Number(r.pFinal),  maxFinal);
          pAssign = clamp(Number(r.pAssign), maxAssign);
          pAttend = clamp(Number(r.pAttend), maxAttend);
          practicalTotal = (pFirst || 0) + (pFinal || 0) + (pAssign || 0) + (pAttend || 0);
        } else {
          practicalTotal = Number(r.practicalTotal);
          if (!Number.isFinite(practicalTotal) || practicalTotal < 0) {
            return res.status(400).json({ error: "practicalTotal must be a non-negative number or provide parts" });
          }
        }

        ops.push({
          updateOne: {
            filter: { courseInstance: courseInstanceId, student: r.student, kind: "practical" },
            update: {
              $set: {
                courseInstance: courseInstanceId,
                student: r.student,
                kind: "practical",
                ...(hasParts ? { pFirst, pFinal, pAssign, pAttend } : {}),
                practicalTotal,
                remarks: r.remarks || null,
                filledBy: req.user._id
              }
            },
            upsert: true
          }
        });
      }

      const result = await InternalRecord.bulkWrite(ops, { ordered: false });
      res.json({ success: true, result });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

/* ───────── 4) List by courseInstance (teacher/admin) ─────────
   GET /results/list/:courseInstanceId?kind=exam|practical&attemptNo=1|2|3
*/
ResultRouter.get(
  "/list/:courseInstanceId",
  authmiddleware,
  authorizedRole("teacher", "admin"),
  async (req, res) => {
    try {
      const { courseInstanceId } = req.params;
      if (!isValidObjectId(courseInstanceId)) return res.status(400).json({ error: "Invalid courseInstance id" });

      if (req.user.role === "teacher") await ensureTeacherOwnsCI(courseInstanceId, req.user._id);

      const { kind, attemptNo } = req.query;
      const q = { courseInstance: courseInstanceId };
      if (kind) q.kind = String(kind);
      if (attemptNo) q.attemptNo = Number(attemptNo);

      const rows = await InternalRecord.find(q)
        .populate("student", "username email name _id")
        .populate("filledBy", "username role _id")
        .lean();

      res.json(rows);
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

/* ───────── 5) Admin verify & lock a record ───────── */
ResultRouter.post(
  "/verify/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid record id" });

      const doc = await InternalRecord.findByIdAndUpdate(
        id,
        { verifiedBy: req.user._id },
        { new: true }
      );
      res.json({ success: true, record: doc });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

ResultRouter.post(
  "/lock/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid record id" });

      const doc = await InternalRecord.findByIdAndUpdate(
        id,
        { lockedByAdmin: true },
        { new: true }
      );
      res.json({ success: true, record: doc });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  }
);

export default ResultRouter;
