// src/routes/adminRoute.js
// ESM expected (type: "module")

import express from "express";
import mongoose from "mongoose";

import User from "../users/user-model.js";
import Faculty from "../faculty/faculty-model.js";
import Batch from "../batch/batch-model.js";
import Course from "../course/course-model.js";
import SemesterOrYear from "../semoryear/sem-model.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import attendanceRecordModel from "../attendance/attendanceRecord-model.js"
import LeaveRequest from "../functions/leave_request_model.js";
const adminRoute = express.Router();

// helpers
const coll = (name) => mongoose.model(name).collection.name; // real collection name
const n0 = (n) => (typeof n === "number" && !Number.isNaN(n) ? n : 0);
const isValidId = (v) => mongoose.isValidObjectId(String(v));

// parse YYYY-MM-DD → Date range (UTC day)
function parseDateRange(q) {
  const { start, end, days } = q;

  const toDayStart = (s) => new Date(`${s}T00:00:00.000Z`);
  const toDayEnd   = (s) => new Date(`${s}T23:59:59.999Z`);

  let from, to;

  if (start && end) {
    from = toDayStart(String(start));
    to   = toDayEnd(String(end));
  } else if (days && Number(days) > 0) {
    const n = Math.min(365, Math.max(1, Number(days)));
    to = new Date();
    from = new Date(to);
    from.setUTCDate(to.getUTCDate() - (n - 1));
    from = new Date(`${from.toISOString().slice(0,10)}T00:00:00.000Z`);
    to   = new Date(`${to.toISOString().slice(0,10)}T23:59:59.999Z`);
  } else {
    const today = new Date().toISOString().slice(0,10);
    from = new Date(`${today}T00:00:00.000Z`);
    to   = new Date(`${today}T23:59:59.999Z`);
  }

  return { from, to };
}

/**
 * GET /admin-api/summary
 * Totals for cards (users/roles/states + entities)
 */
adminRoute.get(
  "/summary",
  authmiddleware,
  authorizedRole("admin"),
  async (_req, res, next) => {
    try {
      const [
        usersTotal,
        studentsTotal,
        teachersTotal,
        adminsTotal,
        superadminsTotal,
        activeUsers,
        inactiveUsers,
        verifiedUsers,
        unverifiedUsers,
        facultiesTotal,
        batchesTotal,
        coursesTotal,
        semYearsTotal,
      ] = await Promise.all([
        User.estimatedDocumentCount(),
        User.countDocuments({ role: "student" }),
        User.countDocuments({ role: "teacher" }),
        User.countDocuments({ role: "admin" }),
        User.countDocuments({ role: "superadmin" }),
        User.countDocuments({ isActive: true }),
        User.countDocuments({ isActive: false }),
        User.countDocuments({ isVerified: true }),
        User.countDocuments({ isVerified: false }),
        Faculty.estimatedDocumentCount(),
        Batch.estimatedDocumentCount(),
        Course.estimatedDocumentCount(),
        SemesterOrYear.estimatedDocumentCount(),
      ]);

      res.json({
        ok: true,
        totals: {
          users: n0(usersTotal),
          students: n0(studentsTotal),
          teachers: n0(teachersTotal),
          admins: n0(adminsTotal),
          superadmins: n0(superadminsTotal),
          activeUsers: n0(activeUsers),
          inactiveUsers: n0(inactiveUsers),
          verifiedUsers: n0(verifiedUsers),
          unverifiedUsers: n0(unverifiedUsers),
        },
        entities: {
          faculties: n0(facultiesTotal),
          batches: n0(batchesTotal),
          courses: n0(coursesTotal),
          semesterOrYears: n0(semYearsTotal),
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin-api/students-by-faculty
 * Students grouped by faculty (INCLUDES faculties with zero students)
 */
adminRoute.get(
  "/students-by-faculty",
  authmiddleware,
  authorizedRole("admin"),
  async (_req, res, next) => {
    try {
      const data = await Faculty.aggregate([
        { $project: { name: 1, code: 1 } },
        {
          $lookup: {
            from: mongoose.model("Batch").collection.name,
            localField: "_id",
            foreignField: "faculty",
            as: "batches",
          },
        },
        {
          $set: {
            batchIds: { $map: { input: "$batches", as: "b", in: "$$b._id" } },
          },
        },
        {
          $lookup: {
            from: mongoose.model("User").collection.name,
            let: { batchIds: "$batchIds" },
            pipeline: [
              { $match: { role: "student" } },
              { $match: { $expr: { $in: ["$batch", "$$batchIds"] } } },
            ],
            as: "students",
          },
        },
        { $set: { count: { $size: "$students" } } },
        { $project: { students: 0, batches: 0, batchIds: 0 } },
        { $sort: { count: -1, name: 1 } },
      ]);

      res.json({ ok: true, items: data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin-api/students-by-batch?limit=12&facultyId=<ObjectId>
 * Students grouped by batch; supports drill-down for a specific faculty (INCLUDES batches with zero students)
 */
adminRoute.get(
  "/students-by-batch",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const { facultyId } = req.query;

      const match = {};
      if (facultyId && mongoose.isValidObjectId(String(facultyId))) {
        match.faculty = new mongoose.Types.ObjectId(String(facultyId));
      }

      const data = await Batch.aggregate([
        { $match: match },
        {
          $lookup: {
            from: mongoose.model("User").collection.name,
            let: { batchId: "$._id" },
            pipeline: [
              { $match: { role: "student" } },
              { $match: { $expr: { $eq: ["$batch", "$$batchId"] } } },
            ],
            as: "students",
          },
        },
        { $set: { count: { $size: "$students" } } },
        {
          $project: {
            students: 0,
            batchname: 1,
            startYear: 1,
            currentSemesterOrYear: 1,
            isCompleted: 1,
          },
        },
        { $sort: { count: -1, startYear: -1 } },
        { $limit: limit },
      ]);

      res.json({ ok: true, items: data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin-api/attendance/overview
 * Overview of attendance between dates (default = today). Optional scope by facultyId or batchId.
 * Query:
 *   - start=YYYY-MM-DD & end=YYYY-MM-DD  OR  days=N
 *   - facultyId=<ObjectId>  (optional)
 *   - batchId=<ObjectId>    (optional)
 * Response:
 *   { ok, range, scope, counts: {present, absent, late, total}, daily: [{date, present, absent, late, total}] }
 */
adminRoute.get(
  "/attendance/overview",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const { facultyId, batchId } = req.query;

      const pipeline = [
        { $match: { markedAt: { $gte: from, $lte: to } } },
        {
          $lookup: {
            from: coll("User"),
            localField: "student",
            foreignField: "_id",
            as: "stu",
          },
        },
        { $unwind: "$stu" },
        { $match: { "stu.role": "student" } },
      ];

      if ((batchId && isValidId(batchId)) || (facultyId && isValidId(facultyId))) {
        pipeline.push(
          {
            $lookup: {
              from: coll("Batch"),
              localField: "stu.batch",
              foreignField: "_id",
              as: "batch",
            },
          },
          { $unwind: { path: "$batch", preserveNullAndEmptyArrays: true } }
        );
        if (batchId && isValidId(batchId)) {
          pipeline.push({ $match: { "batch._id": new mongoose.Types.ObjectId(String(batchId)) } });
        }
        if (facultyId && isValidId(facultyId)) {
          pipeline.push({ $match: { "batch.faculty": new mongoose.Types.ObjectId(String(facultyId)) } });
        }
      }

      pipeline.push({
        $facet: {
          totals: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          daily: [
            {
              $group: {
                _id: {
                  d: { $dateToString: { format: "%Y-%m-%d", date: "$markedAt" } },
                  s: "$status",
                },
                count: { $sum: 1 },
              },
            },
            {
              $group: {
                _id: "$_id.d",
                items: { $push: { k: "$_id.s", v: "$count" } },
                total: { $sum: "$count" },
              },
            },
            {
              $project: {
                _id: 0,
                date: "$_id",
                obj: { $arrayToObject: "$items" },
                total: 1,
              },
            },
            {
              $project: {
                date: 1,
                total: 1,
                present: { $ifNull: ["$obj.present", 0] },
                absent:  { $ifNull: ["$obj.absent", 0] },
                late:    { $ifNull: ["$obj.late", 0] },
              },
            },
            { $sort: { date: 1 } },
          ],
        },
      });

      const [{ totals, daily }] = await attendanceRecordModel.aggregate(pipeline);

      const totalsMap = Object.fromEntries((totals || []).map(t => [t._id, t.count]));
      const present = totalsMap.present || 0;
      const absent  = totalsMap.absent  || 0;
      const late    = totalsMap.late    || 0;
      const total   = present + absent + late;

      res.json({
        ok: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        scope: {
          facultyId: isValidId(facultyId) ? String(facultyId) : undefined,
          batchId:   isValidId(batchId)   ? String(batchId)   : undefined,
        },
        counts: { present, absent, late, total },
        daily: daily || [],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin-api/leaves/recent?limit=5&status=pending
 * Recent leave requests (default: latest 5 with status=pending)
 */
adminRoute.get(
  "/leaves/recent",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 5));
      const status = (req.query.status || "pending").toString();

      const items = await LeaveRequest.find({ status })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({ path: "user", select: "username email role" })
        .lean();

      res.json({
        ok: true,
        items: items.map((it) => ({
          _id: it._id,
          user: it.user
            ? {
                _id: it.user._id,
                username: it.user.username,
                email: it.user.email,
                role: it.user.role,
              }
            : null,
          role: it.role,
          leaveDate: it.leaveDate, // "YYYY-MM-DD"
          dayPart: it.dayPart,
          type: it.type,
          reason: it.reason || "",
          status: it.status,
          createdAt: it.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default adminRoute;
