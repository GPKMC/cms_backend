// attendance/socketFunction.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import attendanceSessionModel from "./attendanceSession-model.js";

function authFromHandshake(socket) {
  // token from socket.auth.token OR Authorization header
  const token = socket.handshake.auth?.token
    || (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const u = jwt.verify(token, process.env.JWT_SECRET);
    return { ...u, _id: u._id || u.id };
  } catch {
    return null;
  }
}

// room name helper
export const sessionRoom = (sessionId) => `attendance:session:${sessionId}`;

export function createRealtime(httpServer, corsOrigins = ["http://localhost:3000"]) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true }
  });

  io.use((socket, next) => {
    const user = authFromHandshake(socket);
    if (!user) return next(new Error("unauthorized"));
    socket.user = user; // {_id, role, ...}
    next();
  });

  io.on("connection", (socket) => {
    // Teacher (or admin) joins a session room to receive live updates
    socket.on("join-session", async (sessionId, ack) => {
      try {
        const s = await attendanceSessionModel.findById(sessionId).select("teacher isClosed courseInstance");
        if (!s) return ack?.({ ok: false, error: "session_not_found" });
        if (s.isClosed) return ack?.({ ok: false, error: "session_closed" });

        // If teacher: must own this session. Admin/superadmin allowed.
        if (socket.user.role === "teacher" && String(s.teacher) !== String(socket.user._id)) {
          return ack?.({ ok: false, error: "not_session_teacher" });
        }

        socket.join(sessionRoom(sessionId));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: "server_error" });
      }
    });

    socket.on("leave-session", (sessionId) => {
      socket.leave(sessionRoom(sessionId));
    });

    socket.on("disconnect", () => {});
  });

  // handy emitters for routes
  io.emitters = {
    attendanceUpdated(sessionId, record) {
      io.to(sessionRoom(sessionId)).emit("attendance:updated", { record });
    },
    sessionClosed(sessionId) {
      io.to(sessionRoom(sessionId)).emit("attendance:closed", { sessionId });
    },
    sessionOpened(session) {
      io.to(sessionRoom(session._id)).emit("attendance:opened", { sessionId: String(session._id) });
    }
  };

  return io;
}
