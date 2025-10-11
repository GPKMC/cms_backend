// routes/leave.routes.js
import express from "express";
import LeaveRequest from "./leave_request_model.js";
import LeaveEmailTemplate from "./leave-template.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
import User from "../users/user-model.js";

import {
  getTransporter,
  getMailFrom,
  getReplyTo,
  applyDebugRouting,
  getPreviewUrl,
  getDriverName,
} from "../utils/mailer.js";

const leaveRouter = express.Router();

/* ---------- helpers ---------- */
const TZ = "Asia/Kathmandu";
const ymdInTZ = (d = new Date(), tz = TZ) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
// en-CA -> "YYYY-MM-DD"
const isPast = (ymd) => ymd < ymdInTZ();

const TYPES = [
  { id: "sick",      label: "Sick Leave",       defaultReason: "Feeling unwell; requesting rest for recovery." },
  { id: "emergency", label: "Emergency Leave",  defaultReason: "Urgent personal emergency; requesting leave." },
  { id: "function",  label: "Function/Program", defaultReason: "Attending an important function/program." },
  { id: "puja",      label: "Puja/Worship",     defaultReason: "Observing a religious puja/ritual." },
  { id: "personal",  label: "Personal Work",    defaultReason: "Personal work that requires my presence." },
  { id: "other",     label: "Other",            defaultReason: "" },
];

const ADMIN_LEAVE_TO = (process.env.ADMIN_LEAVE_TO || process.env.MAIL_FROM || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function typeLabel(type) {
  return TYPES.find((t) => t.id === String(type))?.label || String(type);
}
function typeDefault(type) {
  return TYPES.find((t) => t.id === String(type))?.defaultReason || "";
}
/** Merge reason with sensible fallback order. */
function mergeReason(type, { reason, customMessage, rejectionReason } = {}) {
  return (customMessage || rejectionReason || reason || typeDefault(type)).trim();
}

const wrapHtml = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.45;color:#111">
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;max-width:700px">
      ${inner}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
      <div style="font-size:12px;color:#6b7280">GPKMC eCampus · Automated notice • ${new Date().toLocaleString("en-GB", { timeZone: TZ })}</div>
    </div>
  </div>
`;

function defaultSubject(role, type, data) {
  const who = role === "teacher" ? "Teacher" : "Student";
  return `[Leave Request][${who}] ${data.leaveDate} – ${typeLabel(type)} — ${data.name}`;
}

function defaultHtml(role, type, data, status = "pending") {
  const who = role === "teacher" ? "Teacher" : "Student";
  const badgeColor =
    status === "approved" ? "#059669" : status === "rejected" ? "#dc2626" : "#2563eb";
  const badgeBg =
    status === "approved" ? "#ecfdf5" : status === "rejected" ? "#fef2f2" : "#eff6ff";
  const reason = mergeReason(type, data);
  const dayPart =
    data.dayPart === "first_half"
      ? "First Half"
      : data.dayPart === "second_half"
      ? "Second Half"
      : "Full Day";
  return wrapHtml(`
    <h2 style="margin:0 0 8px">Leave Request — ${who}</h2>
    <div style="display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};border:1px solid ${badgeColor}">${status.toUpperCase()}</div>
    <p style="margin:12px 0 0">A ${who.toLowerCase()} has submitted a leave request.</p>
    <table style="margin-top:12px;border-collapse:collapse;width:100%">
      <tbody>
        <tr><td style="padding:6px 0;color:#6b7280;width:160px">Name</td><td style="padding:6px 0;">${data.name} (${data.email})</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Role</td><td style="padding:6px 0;">${who}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Date</td><td style="padding:6px 0;">${data.leaveDate} (${dayPart})</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Type</td><td style="padding:6px 0;">${typeLabel(type)}</td></tr>
        ${reason ? `<tr><td style="padding:6px 0;color:#6b7280">Reason</td><td style="padding:6px 0;white-space:pre-wrap">${reason}</td></tr>` : ""}
      </tbody>
    </table>
  `);
}

function defaultText(role, type, data, status = "pending") {
  const who = role === "teacher" ? "Teacher" : "Student";
  const dayPart =
    data.dayPart === "first_half"
      ? "First Half"
      : data.dayPart === "second_half"
      ? "Second Half"
      : "Full Day";
  const reason = mergeReason(type, data);
  return [
    `Leave Request — ${who} [${status.toUpperCase()}]`,
    `Name: ${data.name} (${data.email})`,
    `Role: ${who}`,
    `Date: ${data.leaveDate} (${dayPart})`,
    `Type: ${typeLabel(type)}`,
    reason ? `Reason: ${reason}` : null,
    "",
    "GPKMC eCampus",
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadTemplate(role, type) {
  const tpl = await LeaveEmailTemplate.findOne({ role, type, enabled: true }).lean();
  return tpl || null;
}
function fillTemplate(tplStr, data) {
  return tplStr.replace(/\{(\w+)\}/g, (_, k) => data?.[k] ?? "");
}

/** Send emails.
 *  - status === "pending": send to admin + a copy to requester
 *  - status in {"approved","rejected"}: send to requester only
 */
async function sendLeaveEmails({ role, type, status = "pending", data }) {
  const transporter = await getTransporter();
  const { email: fromEmail, name: fromName } = getMailFrom();
  const { replyToEmail, replyToName } = getReplyTo();

  const tpl = await loadTemplate(role, type);
  const subjectBase = data.subject || (tpl ? fillTemplate(tpl.subject, data) : defaultSubject(role, type, data));
  const html = tpl ? fillTemplate(tpl.html, data) : defaultHtml(role, type, data, status);
  const text = tpl ? fillTemplate(tpl.text, data) : defaultText(role, type, data, status);

  const adminTo = ADMIN_LEAVE_TO.length ? ADMIN_LEAVE_TO : [fromEmail];
  const reqTo = [data.email].filter(Boolean);

  const baseMessage = {
    from: `${fromName} <${fromEmail}>`,
    replyTo: data.email
      ? `${data.name || "User"} <${data.email}>`
      : `${replyToName} <${replyToEmail}>`,
    subject: subjectBase,
    text,
    html,
  };

  const driver = getDriverName();

  // Pending -> admin + copy to requester
  if (status === "pending") {
    // Admin
    {
      const routed = applyDebugRouting({ to: adminTo, bcc: undefined });
      const info = await transporter.sendMail({ ...baseMessage, ...routed });
      const pv = getPreviewUrl(info);
      console.log(`[leave:mail][pending][${driver}] admin ->`, routed.to || routed.bcc, pv || info.messageId);
    }
    // Requester copy
    if (reqTo.length) {
      const routed = applyDebugRouting({ to: reqTo, bcc: undefined });
      const info = await transporter.sendMail({
        ...baseMessage,
        ...routed,
        subject: `[Copy] ${subjectBase}`,
      });
      const pv = getPreviewUrl(info);
      console.log(`[leave:mail][pending][${driver}] requester ->`, routed.to || routed.bcc, pv || info.messageId);
    }
    return;
  }

  // Decision -> requester only
  if (reqTo.length) {
    const routed = applyDebugRouting({ to: reqTo, bcc: undefined });
    const info = await transporter.sendMail({
      ...baseMessage,
      ...routed,
      subject:
        status === "approved"
          ? `✅ Leave approved — ${subjectBase}`
          : status === "rejected"
          ? `❌ Leave rejected — ${subjectBase}`
          : subjectBase,
    });
    const pv = getPreviewUrl(info);
    console.log(`[leave:mail][decision ${status}][${driver}] requester ->`, routed.to || routed.bcc, pv || info.messageId);
  }
}

/* ============================================================================
 * PUBLIC: Get templates + day parts (role-aware)


// ✅ BUGFIX: your snippet had `router.get`—use `leaveRouter.get`
leaveRouter.get("/templates", authmiddleware, (req, res) => {
  const role = String(req.query.role || "").toLowerCase();
  res.json({
    role: (role === "teacher" || role === "student") ? role : undefined,
    types: TYPES,
    dayParts: ["full", "first_half", "second_half"],
  });
});

/* ============================================================================
 * TEACHER
 * ==========================================================================*/
leaveRouter.post(
  "/teacher/request",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) return res.status(401).json({ error: "Unauthenticated" });

      const {
        leaveDate = ymdInTZ(),
        type,
        dayPart = "full",
        reason = "",
        customMessage = "",
        customSubject = "",
      } = req.body || {};

      if (!type || !TYPES.some((t) => t.id === String(type))) return res.status(400).json({ error: "Invalid leave type" });
      if (!["full", "first_half", "second_half"].includes(dayPart)) return res.status(400).json({ error: "Invalid dayPart" });
      if (!leaveDate || typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) return res.status(400).json({ error: "leaveDate must be 'YYYY-MM-DD'" });
      if (isPast(leaveDate)) return res.status(400).json({ error: "Cannot request leave for past dates" });

      const dup = await LeaveRequest.findOne({ user: userId, leaveDate, status: { $in: ["pending", "approved"] } }).lean();
      if (dup) return res.status(409).json({ error: "Leave already requested/approved for this date" });

      const me = await User.findById(userId).select("username email").lean();
      const mergedReason = mergeReason(type, { reason, customMessage });

      const doc = await LeaveRequest.create({
        user: userId,
        role: "teacher",
        leaveDate,
        type,
        dayPart,
        reason: mergedReason, // store merged
        status: "pending",
      });

      const data = {
        id: String(doc._id),
        name: me?.username || req.user?.username || "Teacher",
        email: me?.email || req.user?.email || "",
        leaveDate,
        dayPart,
        type,
        reason: mergedReason,
        customMessage: mergedReason,
        subject: customSubject || undefined,
      };

      await sendLeaveEmails({ role: "teacher", type, status: "pending", data });
      res.status(201).json({ ok: true, leave: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.get(
  "/teacher/mine",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      const { from, to, limit = 30 } = req.query;

      const q = { user: userId };
      if (from || to) {
        q.leaveDate = {};
        if (from) q.leaveDate.$gte = String(from);
        if (to) q.leaveDate.$lte = String(to);
      }

      const items = await LeaveRequest.find(q)
        .sort({ leaveDate: -1, createdAt: -1 })
        .limit(Number(limit) || 30)
        .lean();

      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.patch(
  "/teacher/:id/cancel",
  authmiddleware,
  authorizedRole("teacher"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      const leave = await LeaveRequest.findById(req.params.id);
      if (!leave) return res.status(404).json({ error: "Not found" });
      if (String(leave.user) !== String(userId)) return res.status(403).json({ error: "Not your leave" });
      if (leave.status !== "pending") return res.status(400).json({ error: "Only pending requests can be cancelled" });
      leave.status = "cancelled";
      await leave.save();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/* ============================================================================
 * STUDENT
 * ==========================================================================*/
leaveRouter.post(
  "/student/request",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      if (!userId) return res.status(401).json({ error: "Unauthenticated" });

      const {
        leaveDate = ymdInTZ(),
        type,
        dayPart = "full",
        reason = "",
        customMessage = "",
        customSubject = "",
      } = req.body || {};

      if (!type || !TYPES.some((t) => t.id === String(type))) return res.status(400).json({ error: "Invalid leave type" });
      if (!["full", "first_half", "second_half"].includes(dayPart)) return res.status(400).json({ error: "Invalid dayPart" });
      if (!leaveDate || typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) return res.status(400).json({ error: "leaveDate must be 'YYYY-MM-DD'" });
      if (isPast(leaveDate)) return res.status(400).json({ error: "Cannot request leave for past dates" });

      const dup = await LeaveRequest.findOne({ user: userId, leaveDate, status: { $in: ["pending", "approved"] } }).lean();
      if (dup) return res.status(409).json({ error: "Leave already requested/approved for this date" });

      const me = await User.findById(userId).select("username email").lean();
      const mergedReason = mergeReason(type, { reason, customMessage });

      const doc = await LeaveRequest.create({
        user: userId,
        role: "student",
        leaveDate,
        type,
        dayPart,
        reason: mergedReason, // store merged
        status: "pending",
      });

      const data = {
        id: String(doc._id),
        name: me?.username || req.user?.username || "Student",
        email: me?.email || req.user?.email || "",
        leaveDate,
        dayPart,
        type,
        reason: mergedReason,
        customMessage: mergedReason,
        subject: customSubject || undefined,
      };

      await sendLeaveEmails({ role: "student", type, status: "pending", data });
      res.status(201).json({ ok: true, leave: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.get(
  "/student/mine",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      const { from, to, limit = 30 } = req.query;

      const q = { user: userId };
      if (from || to) {
        q.leaveDate = {};
        if (from) q.leaveDate.$gte = String(from);
        if (to) q.leaveDate.$lte = String(to);
      }

      const items = await LeaveRequest.find(q)
        .sort({ leaveDate: -1, createdAt: -1 })
        .limit(Number(limit) || 30)
        .lean();

      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.patch(
  "/student/:id/cancel",
  authmiddleware,
  authorizedRole("student"),
  async (req, res) => {
    try {
      const userId = req.user?._id;
      const leave = await LeaveRequest.findById(req.params.id);
      if (!leave) return res.status(404).json({ error: "Not found" });
      if (String(leave.user) !== String(userId)) return res.status(403).json({ error: "Not your leave" });
      if (leave.status !== "pending") return res.status(400).json({ error: "Only pending requests can be cancelled" });
      leave.status = "cancelled";
      await leave.save();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/* ============================================================================
 * ADMIN: pending/history + approve/reject
 * ==========================================================================*/
leaveRouter.get(
  "/admin/pending",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const role = req.query.role; // optional: "teacher" | "student"
      const q = { status: "pending" };
      if (role) q.role = role;
      const items = await LeaveRequest.find(q)
        .sort({ leaveDate: 1, createdAt: 1 })
        .limit(100)
        .populate("user", "username email role")
        .lean();
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// count for navbar badge
leaveRouter.get(
  "/admin/pending/count",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const role = req.query.role;
      const q = { status: "pending" };
      if (role) q.role = String(role);
      const count = await LeaveRequest.countDocuments(q);
      res.json({ count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// history
leaveRouter.get(
  "/admin/requests",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { role, status, from, to, limit = 100 } = req.query;
      const q = {};
      if (role) q.role = String(role);
      if (status && status !== "all") q.status = String(status);
      if (from || to) {
        q.leaveDate = {};
        if (from) q.leaveDate.$gte = String(from);
        if (to) q.leaveDate.$lte = String(to);
      }
      const items = await LeaveRequest.find(q)
        .sort({ leaveDate: -1, createdAt: -1 })
        .limit(Number(limit) || 100)
        .populate("user", "username email role")
        .lean();
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.patch(
  "/admin/:id/approve",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const doc = await LeaveRequest.findById(req.params.id)
        .populate("user", "username email role")
        .exec();
      if (!doc) return res.status(404).json({ error: "Not found" });
      if (doc.status !== "pending") return res.status(400).json({ error: "Only pending requests can be approved" });

      doc.status = "approved";
      doc.approvedBy = req.user?._id;
      doc.approvedAt = new Date();
      await doc.save();

      const merged = mergeReason(doc.type, { reason: doc.reason });
      const data = {
        id: String(doc._id),
        name: doc.user?.username || "User",
        email: doc.user?.email || "",
        leaveDate: doc.leaveDate,
        dayPart: doc.dayPart,
        type: doc.type,
        reason: merged,
        customMessage: merged,
      };
      await sendLeaveEmails({ role: doc.role, type: doc.type, status: "approved", data });

      res.json({ ok: true, leave: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

leaveRouter.patch(
  "/admin/:id/reject",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { reason = "" } = req.body || {};
      const doc = await LeaveRequest.findById(req.params.id)
        .populate("user", "username email role")
        .exec();
      if (!doc) return res.status(404).json({ error: "Not found" });
      if (doc.status !== "pending") return res.status(400).json({ error: "Only pending requests can be rejected" });

      doc.status = "rejected";
      doc.rejectionReason = reason;
      doc.approvedBy = req.user?._id;
      doc.approvedAt = new Date();
      await doc.save();

      const merged = mergeReason(doc.type, { reason: doc.reason, rejectionReason: reason });
      const data = {
        id: String(doc._id),
        name: doc.user?.username || "User",
        email: doc.user?.email || "",
        leaveDate: doc.leaveDate,
        dayPart: doc.dayPart,
        type: doc.type,
        reason: merged,
        customMessage: merged,
      };
      await sendLeaveEmails({ role: doc.role, type: doc.type, status: "rejected", data });

      res.json({ ok: true, leave: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

export default leaveRouter;
