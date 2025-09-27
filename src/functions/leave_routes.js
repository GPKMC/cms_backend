import express from "express";
import LeaveRequest from "./leave_request_model.js";
import LeaveEmailTemplate from "./leave-template.js";
import { authmiddleware, authorizedRole } from "../users/user-middleware.js";
// If you have a User model and want to populate names/emails reliably:
import User from "../users/user-model.js";

// ✅ Your mailer utils (you already have these in the project)
import {
  getTransporter,
  getMailFrom,
  getReplyTo,
  applyDebugRouting,
} from "../utils/mailer.js";

const leaveRouter = express.Router();

/* ---------- helpers ---------- */
const TZ = "Asia/Kathmandu";
const ymdInTZ = (d = new Date(), tz = TZ) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
// en-CA yields "YYYY-MM-DD"
const isPast = (ymd) => ymd < ymdInTZ();

const TYPES = [
  { id: "sick",      label: "Sick Leave",            defaultReason: "Feeling unwell; requesting rest for recovery." },
  { id: "emergency", label: "Emergency Leave",       defaultReason: "Urgent personal emergency; requesting leave." },
  { id: "function",  label: "Function/Program",      defaultReason: "Attending an important function/program." },
  { id: "puja",      label: "Puja/Worship",          defaultReason: "Observing a religious puja/ritual." },
  { id: "personal",  label: "Personal Work",         defaultReason: "Personal work that requires my presence." },
  { id: "other",     label: "Other",                 defaultReason: "" },
];

// Admin inbox (comma-separated). Fallback to MAIL_FROM if not set.
const ADMIN_LEAVE_TO = (process.env.ADMIN_LEAVE_TO || process.env.MAIL_FROM || "").split(",").map(s => s.trim()).filter(Boolean);

// Basic HTML wrapper
const wrapHtml = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.45;color:#111">
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;max-width:700px">
      ${inner}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
      <div style="font-size:12px;color:#6b7280">GPKMC eCampus · Automated notice • ${new Date().toLocaleString("en-GB", { timeZone: TZ })}</div>
    </div>
  </div>
`;

// Default subjects and bodies (used when no DB template found)
function defaultSubject(role, type, data) {
  const who = role === "teacher" ? "Teacher" : "Student";
  return `[Leave Request][${who}] ${data.leaveDate} – ${typeLabel(type)} — ${data.name}`;
}
function typeLabel(type) {
  return TYPES.find(t => t.id === type)?.label || type;
}
function defaultHtml(role, type, data, status = "pending") {
  const who = role === "teacher" ? "Teacher" : "Student";
  const badgeColor = status === "approved" ? "#059669" : status === "rejected" ? "#dc2626" : "#2563eb";
  const badgeBg = status === "approved" ? "#ecfdf5" : status === "rejected" ? "#fef2f2" : "#eff6ff";
  const reason = (data.customMessage || data.reason || "").trim();
  const dayPart = data.dayPart === "first_half" ? "First Half" : data.dayPart === "second_half" ? "Second Half" : "Full Day";
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
  const dayPart = data.dayPart === "first_half" ? "First Half" : data.dayPart === "second_half" ? "Second Half" : "Full Day";
  return [
    `Leave Request — ${who} [${status.toUpperCase()}]`,
    `Name: ${data.name} (${data.email})`,
    `Role: ${who}`,
    `Date: ${data.leaveDate} (${dayPart})`,
    `Type: ${typeLabel(type)}`,
    data.customMessage || data.reason ? `Reason: ${data.customMessage || data.reason}` : null,
    "",
    "GPKMC eCampus"
  ].filter(Boolean).join("\n");
}

async function loadTemplate(role, type) {
  const tpl = await LeaveEmailTemplate.findOne({ role, type, enabled: true }).lean();
  return tpl || null;
}
function fillTemplate(tplStr, data) {
  // Replace {placeholders} in template strings
  return tplStr.replace(/\{(\w+)\}/g, (_, k) => data?.[k] ?? "");
}

/** Send emails:
 *  - To Admin inbox (pending)
 *  - To requester (confirmation)
 *  - On approval/rejection, notify requester with status
 */
async function sendLeaveEmails({ role, type, status = "pending", data }) {
  const transporter = await getTransporter();
  const from = await getMailFrom();
  const replyTo = await getReplyTo(); // often noreply@ but you can set to admin inbox if desired

  // Load DB template (if any)
  const tpl = await loadTemplate(role, type);

  // Build subject/HTML/text for admin & requester
  const subject = tpl ? fillTemplate(tpl.subject, data) : defaultSubject(role, type, data);
  const html = tpl ? fillTemplate(tpl.html, data) : defaultHtml(role, type, data, status);
  const text = tpl ? fillTemplate(tpl.text, data) : defaultText(role, type, data, status);

  const adminTo = ADMIN_LEAVE_TO.length ? ADMIN_LEAVE_TO : [from.address || from];
  const reqTo = [data.email].filter(Boolean);

  // ⚙️ Route through debug rules if you use them (e.g., in dev)
  const adminMail = applyDebugRouting({
    from,
    to: adminTo,
    replyTo: data.email || replyTo,
    subject,
    text,
    html,
  });
  const requesterMail = applyDebugRouting({
    from,
    to: reqTo,
    replyTo,
    subject: `[Copy] ${subject}`,
    text,
    html,
  });

  // Send (ignore failures individually)
  const results = [];
  try { results.push(await transporter.sendMail(adminMail)); } catch (e) { results.push({ error: e.message }); }
  try { results.push(await transporter.sendMail(requesterMail)); } catch (e) { results.push({ error: e.message }); }
  return results;
}

/* ============================================================================
 * PUBLIC: Get templates + day parts (role-aware)
 * ==========================================================================*/

// ✅ BUGFIX: your snippet had `router.get`—use `leaveRouter.get`
leaveRouter.get("/templates", authmiddleware, (req, res) => {
  const role = String(req.query.role || "").toLowerCase();
  const filteredTypes = (role === "teacher" || role === "student")
    ? TYPES
    : TYPES;
  res.json({
    role: (role === "teacher" || role === "student") ? role : undefined,
    types: filteredTypes,
    dayParts: ["full", "first_half", "second_half"],
  });
});

/* ============================================================================
 * TEACHER ENDPOINTS
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
        customMessage = "",   // optional: lets teacher tweak email body text
        customSubject = "",   // optional: subject override
      } = req.body || {};

      if (!type || !TYPES.some(t => t.id === String(type))) return res.status(400).json({ error: "Invalid leave type" });
      if (!["full", "first_half", "second_half"].includes(dayPart)) return res.status(400).json({ error: "Invalid dayPart" });
      if (!leaveDate || typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) return res.status(400).json({ error: "leaveDate must be 'YYYY-MM-DD'" });
      if (isPast(leaveDate)) return res.status(400).json({ error: "Cannot request leave for past dates" });

      const dup = await LeaveRequest.findOne({ user: userId, leaveDate, status: { $in: ["pending", "approved"] } }).lean();
      if (dup) return res.status(409).json({ error: "Leave already requested/approved for this date" });

      const doc = await LeaveRequest.create({
        user: userId,
        role: "teacher",
        leaveDate,
        type,
        dayPart,
        reason,
        status: "pending",
      });

      // Compose mail data (fetch user to be safe)
      const me = await User.findById(userId).select("username email").lean();
      const data = {
        id: String(doc._id),
        name: me?.username || req.user?.username || "Teacher",
        email: me?.email || req.user?.email || "",
        leaveDate,
        dayPart,
        type,
        reason,
        customMessage: customMessage || reason,
      };
      // Allow subject override if provided
      if (customSubject) data.subject = customSubject;

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

// List by status for admin (history)

// routes/leave.routes.js (same file as your other leaveRouter routes)
leaveRouter.get(
  "/admin/pending/count",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const role = req.query.role; // "teacher" | "student" | undefined
      const q = { status: "pending" };
      if (role) q.role = String(role);
      const count = await LeaveRequest.countDocuments(q);
      res.json({ count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);


leaveRouter.get(
  "/admin/requests",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { role, status, from, to, limit = 100 } = req.query;
      const q = {};
      if (role) q.role = String(role); // "teacher" | "student"
      if (status && status !== "all") q.status = String(status); // "approved" | "rejected" | "cancelled"
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
 * STUDENT ENDPOINTS (same flow, different role + templates)
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

      if (!type || !TYPES.some(t => t.id === String(type))) return res.status(400).json({ error: "Invalid leave type" });
      if (!["full", "first_half", "second_half"].includes(dayPart)) return res.status(400).json({ error: "Invalid dayPart" });
      if (!leaveDate || typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) return res.status(400).json({ error: "leaveDate must be 'YYYY-MM-DD'" });
      if (isPast(leaveDate)) return res.status(400).json({ error: "Cannot request leave for past dates" });

      const dup = await LeaveRequest.findOne({ user: userId, leaveDate, status: { $in: ["pending", "approved"] } }).lean();
      if (dup) return res.status(409).json({ error: "Leave already requested/approved for this date" });

      const doc = await LeaveRequest.create({
        user: userId,
        role: "student",
        leaveDate,
        type,
        dayPart,
        reason,
        status: "pending",
      });

      const me = await User.findById(userId).select("username email").lean();
      const data = {
        id: String(doc._id),
        name: me?.username || req.user?.username || "Student",
        email: me?.email || req.user?.email || "",
        leaveDate,
        dayPart,
        type,
        reason,
        customMessage: customMessage || reason,
      };
      if (customSubject) data.subject = customSubject;

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
 * ADMIN: pending list + approve/reject (for any role)
 * ==========================================================================*/

leaveRouter.get(
  "/admin/pending",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const role = req.query.role; // optional filter: "teacher" | "student"
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

leaveRouter.patch(
  "/admin/:id/approve",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const doc = await LeaveRequest.findById(req.params.id).populate("user", "username email role").exec();
      if (!doc) return res.status(404).json({ error: "Not found" });
      if (doc.status !== "pending") return res.status(400).json({ error: "Only pending requests can be approved" });
      doc.status = "approved";
      doc.approvedBy = req.user?._id;
      doc.approvedAt = new Date();
      await doc.save();

      // Notify requester
      const data = {
        id: String(doc._id),
        name: doc.user?.username || "User",
        email: doc.user?.email || "",
        leaveDate: doc.leaveDate,
        dayPart: doc.dayPart,
        type: doc.type,
        reason: doc.reason,
        customMessage: doc.reason,
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
      const doc = await LeaveRequest.findById(req.params.id).populate("user", "username email role").exec();
      if (!doc) return res.status(404).json({ error: "Not found" });
      if (doc.status !== "pending") return res.status(400).json({ error: "Only pending requests can be rejected" });
      doc.status = "rejected";
      doc.rejectionReason = reason;
      doc.approvedBy = req.user?._id;
      doc.approvedAt = new Date();
      await doc.save();

      // Notify requester
      const data = {
        id: String(doc._id),
        name: doc.user?.username || "User",
        email: doc.user?.email || "",
        leaveDate: doc.leaveDate,
        dayPart: doc.dayPart,
        type: doc.type,
        reason: reason || doc.reason,
        customMessage: reason || doc.reason,
      };
      await sendLeaveEmails({ role: doc.role, type: doc.type, status: "rejected", data });

      res.json({ ok: true, leave: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/* ============================================================================
 * ADMIN: email template CRUD (simple)
 * ==========================================================================*/

// List templates (optionally filter by role/type)
leaveRouter.get(
  "/admin/templates/email",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { role, type } = req.query;
      const q = {};
      if (role) q.role = String(role);
      if (type) q.type = String(type);
      const items = await LeaveEmailTemplate.find(q).sort({ role: 1, type: 1 }).lean();
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Upsert a template
leaveRouter.put(
  "/admin/templates/email",
  authmiddleware,
  authorizedRole("admin"),
  async (req, res) => {
    try {
      const { role, type, subject, html, text, enabled = true } = req.body || {};
      if (!role || !["teacher", "student"].includes(role)) return res.status(400).json({ error: "role must be 'teacher' or 'student'" });
      if (!type) return res.status(400).json({ error: "Missing type" });
      if (!subject || !html || !text) return res.status(400).json({ error: "subject, html, text are required" });

      const doc = await LeaveEmailTemplate.findOneAndUpdate(
        { role, type },
        { subject, html, text, enabled },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      res.json({ ok: true, template: doc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

export default leaveRouter;
