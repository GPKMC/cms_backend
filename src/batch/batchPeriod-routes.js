// routes/batch-period.routes.js
import express from "express";
import mongoose from "mongoose";

import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import BatchPeriod from "./batchPeriod-model.js";

const routBatchPeriodRouter = express.Router();

/* ---------------------------------------------
 * CREATE BatchPeriod
 * --------------------------------------------- */
routBatchPeriodRouter.post(
  "/batchPeriod",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { batch, semesterOrYear, startDate, endDate, status, description } = req.body;

      if (!batch || !semesterOrYear) {
        return res.status(400).json({ ok: false, message: "Missing required fields: batch, semesterOrYear." });
      }

      const Batch = mongoose.model("Batch");
      const SemOrYear = mongoose.model("SemesterOrYear");

      const batchDoc = await Batch.findById(batch);
      const sy = await SemOrYear.findById(semesterOrYear);
      if (!batchDoc) return res.status(400).json({ ok: false, message: "Batch not found." });
      if (!sy) return res.status(400).json({ ok: false, message: "SemesterOrYear not found." });

      // Ensure both point to the same faculty
      if (String(batchDoc.faculty) !== String(sy.faculty)) {
        return res.status(400).json({ ok: false, message: "Batch and SemesterOrYear do not belong to the same faculty." });
      }

      // determine type by sem/year
      const type = sy.semesterNumber ? "semester" : (sy.yearNumber ? "year" : null);
      if (!type) return res.status(400).json({ ok: false, message: "SemesterOrYear must have either semesterNumber or yearNumber." });

      function monthsDiff(start, end) {
        return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      }

      if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffMonths = monthsDiff(start, end);

        if (type === "semester") {
          if (diffMonths < 6) return res.status(400).json({ ok: false, message: "Semester must be at least 6 months long." });
          if (diffMonths > 7) return res.status(400).json({ ok: false, message: "Semester cannot be longer than 7 months." });
        } else {
          if (diffMonths < 12) return res.status(400).json({ ok: false, message: "Year must be at least 12 months long." });
          if (diffMonths > 13) return res.status(400).json({ ok: false, message: "Year cannot be longer than 13 months." });
        }

        // Batch year-range guardrails
        if (batchDoc.startYear && start.getFullYear() < batchDoc.startYear) {
          return res.status(400).json({ ok: false, message: "startDate cannot be earlier than batch start year." });
        }
        if (batchDoc.endYear) {
          if (end.getFullYear() > batchDoc.endYear) {
            return res.status(400).json({ ok: false, message: "endDate cannot be after batch end year." });
          }
          if (start.getFullYear() > batchDoc.endYear) {
            return res.status(400).json({ ok: false, message: "startDate cannot be after batch end year." });
          }
        }
      }

      // Unique pair guard
      const exists = await BatchPeriod.findOne({ batch, semesterOrYear });
      if (exists) return res.status(400).json({ ok: false, message: "BatchPeriod already exists for this batch and semester/year." });

      const bp = await BatchPeriod.create({ batch, semesterOrYear, startDate, endDate, status, description });

      const populated = await BatchPeriod.findById(bp._id)
        .populate({
          path: "batch",
          populate: { path: "faculty", select: "name code" },
        })
        .populate({
          path: "semesterOrYear",
          populate: [
            { path: "faculty", select: "name code" },
            { path: "courses", select: "name code" },
          ],
        });

      res.status(201).json({ ok: true, message: "BatchPeriod created", batchPeriod: populated });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * GET all BatchPeriods (optional filters)
 * Query: ?batch=&semesterOrYear=&status=&faculty=
 * --------------------------------------------- */
routBatchPeriodRouter.get(
  "/batchPeriod",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { batch, faculty, semesterOrYear, status } = req.query;
      const query = {};
      if (batch) query.batch = batch;
      if (semesterOrYear) query.semesterOrYear = semesterOrYear;
      if (status) query.status = status;

      let list = await BatchPeriod.find(query)
        .populate({
          path: "batch",
          populate: { path: "faculty", select: "name code" },
        })
        .populate({
          path: "semesterOrYear",
          populate: [
            { path: "faculty", select: "name code" }, // ✅ ensure we have semYear.faculty for filtering
            { path: "courses", select: "name code" },
          ],
        })
        .sort({ startDate: 1 })
        .lean();

      if (faculty) {
        const fid = String(faculty);
        list = list.filter((bp) => {
          const batchFac = bp?.batch?.faculty;
          const semFac = bp?.semesterOrYear?.faculty;
          const batchFacId = batchFac?._id ? String(batchFac._id) : (batchFac ? String(batchFac) : null);
          const semFacId = semFac?._id ? String(semFac._id) : (semFac ? String(semFac) : null);
          return batchFacId === fid || semFacId === fid;
        });
      }

      res.json({ ok: true, batchPeriods: list });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * GET ongoing BatchPeriod by batch + semesterOrYear
 * /batchPeriod/ongoing?batch=...&semesterOrYear=...
 * (This is the endpoint your frontend uses to auto-fill dates)
 * --------------------------------------------- */
routBatchPeriodRouter.get(
  "/batchPeriod/ongoing",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { batch, semesterOrYear } = req.query;
      if (!batch || !semesterOrYear) {
        return res.status(400).json({ ok: false, message: "batch and semesterOrYear are required" });
      }

      const bp = await BatchPeriod.findOne({
        batch,
        semesterOrYear,
        status: "ongoing",
      })
        .select("startDate endDate status")
        .lean();

      if (!bp) return res.status(404).json({ ok: false, message: "No ongoing BatchPeriod" });
      res.json({ ok: true, period: bp });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * GET single BatchPeriod by ID
 * --------------------------------------------- */
routBatchPeriodRouter.get(
  "/batchPeriod/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, message: "Invalid ID" });
    }
    try {
      const period = await BatchPeriod.findById(req.params.id)
        .populate({
          path: "batch",
          populate: { path: "faculty" },
        })
        .populate({
          path: "semesterOrYear",
          populate: [
            { path: "faculty", select: "name code" },
            { path: "courses", select: "name code" },
          ],
        });

      if (!period) return res.status(404).json({ ok: false, message: "Not found" });
      res.json({ ok: true, batchPeriod: period });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * UPDATE BatchPeriod (status, dates, description)
 * --------------------------------------------- */
routBatchPeriodRouter.patch(
  "/batchPeriod/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, message: "Invalid ID" });
    }
    try {
      const bp = await BatchPeriod.findById(req.params.id);
      if (!bp) return res.status(404).json({ ok: false, message: "Not found" });

      const Batch = mongoose.model("Batch");
      const SemOrYear = mongoose.model("SemesterOrYear");

      const batchDoc = await Batch.findById(bp.batch);
      if (!batchDoc) return res.status(400).json({ ok: false, message: "Batch not found." });

      // Only allow updating status, dates, description (NOT semesterOrYear)
      const allowed = ["startDate", "endDate", "status", "description"];
      for (const k of allowed) {
        if (req.body[k] !== undefined) bp[k] = req.body[k];
      }

      const syDoc = await SemOrYear.findById(bp.semesterOrYear);
      const type = syDoc?.semesterNumber ? "semester" : (syDoc?.yearNumber ? "year" : null);
      if (!type) return res.status(400).json({ ok: false, message: "SemesterOrYear must have either semesterNumber or yearNumber." });

      function monthsDiff(start, end) {
        return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      }

      if (bp.startDate && bp.endDate) {
        const start = new Date(bp.startDate);
        const end = new Date(bp.endDate);
        const diffMonths = monthsDiff(start, end);

        if (type === "semester") {
          if (diffMonths < 6) return res.status(400).json({ ok: false, message: "Semester must be at least 6 months long." });
          if (diffMonths > 7) return res.status(400).json({ ok: false, message: "Semester cannot be longer than 7 months." });
        } else {
          if (diffMonths < 12) return res.status(400).json({ ok: false, message: "Year must be at least 12 months long." });
          if (diffMonths > 13) return res.status(400).json({ ok: false, message: "Year cannot be longer than 13 months." });
        }

        if (batchDoc.startYear && start.getFullYear() < batchDoc.startYear) {
          return res.status(400).json({ ok: false, message: "startDate cannot be earlier than batch start year." });
        }
        if (batchDoc.endYear) {
          if (end.getFullYear() > batchDoc.endYear) {
            return res.status(400).json({ ok: false, message: "endDate cannot be after batch end year." });
          }
          if (start.getFullYear() > batchDoc.endYear) {
            return res.status(400).json({ ok: false, message: "startDate cannot be after batch end year." });
          }
        }
      }

      await bp.save();

      const populated = await BatchPeriod.findById(bp._id)
        .populate({
          path: "batch",
          populate: { path: "faculty", select: "name code" },
        })
        .populate({
          path: "semesterOrYear",
          populate: [
            { path: "faculty", select: "name code" },
            { path: "courses", select: "name code" },
          ],
        });

      res.json({ ok: true, message: "BatchPeriod updated", batchPeriod: populated });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * DELETE BatchPeriod
 * --------------------------------------------- */
routBatchPeriodRouter.delete(
  "/batchPeriod/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, message: "Invalid ID" });
    }
    try {
      const deleted = await BatchPeriod.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ ok: false, message: "Not found" });
      res.json({ ok: true, message: "Deleted" });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

/* ---------------------------------------------
 * GET batch periods by batch id
 * --------------------------------------------- */
routBatchPeriodRouter.get(
  "/batchPeriod/by-batch/:id",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const Batch = mongoose.model("Batch");
      const batch = await Batch.findById(req.params.id);
      if (!batch) return res.status(404).json({ ok: false, message: "Batch not found" });

      const periods = await BatchPeriod.find({ batch: batch._id })
        .populate({
          path: "batch",
          populate: { path: "faculty", select: "name code" },
        })
        .populate({
          path: "semesterOrYear",
          populate: [
            { path: "faculty", select: "name code" },
            { path: "courses", select: "name code" },
          ],
        });

      res.json({ ok: true, batchPeriods: periods });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }
);

export default routBatchPeriodRouter;
