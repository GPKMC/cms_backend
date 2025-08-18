// routes/schedule-solver.routes.js
import express from "express";
import { authmiddleware, authorizedRole } from "../../users/user-middleware.js";
import { solveWeeklyTimetable } from "./scheduler.js";

const scheduleEventRouter = express.Router();

scheduleEventRouter.post(
  "/solve",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { tasks, startDate, endDate, dryRun = false, checkExisting = true } = req.body;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return res.status(400).json({ ok: false, error: "tasks is required (non-empty array)" });
      }
      if (!startDate || !endDate) {
        return res.status(400).json({ ok: false, error: "startDate and endDate are required" });
      }

      const events = await solveWeeklyTimetable(tasks, { startDate, endDate, dryRun, checkExisting });
      res.json({ ok: true, dryRun: !!dryRun, count: events.length, events });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

export default scheduleEventRouter;
