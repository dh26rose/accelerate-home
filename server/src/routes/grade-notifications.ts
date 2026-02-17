import type { FastifyPluginAsync, FastifyReply } from "fastify";

// Limits to prevent abuse and memory overflow
const MAX_CONNECTIONS_PER_STUDENT = 3;
const MISSED_TTL_MS = 24 * 60 * 60 * 1000; // Keep history for 24 hours
const TTL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Clean up every 5 minutes
const KEEPALIVE_INTERVAL_MS = 20 * 1000; // Ping every 20 seconds

export interface GradeNotification {
  id: string;
  studentId: string;
  assignmentId: string;
  grade: number;
  teacherComment?: string;
  publishedAt: Date;
}

interface PublishBody {
  studentId?: string;
  studentIds?: string[];
  assignmentId: string;
  grade: number;
  teacherComment?: string;
}

const gradeNotificationsRoutes: FastifyPluginAsync = async (fastify) => {
  // Active connections: Map studentId -> Set of active HTTP responses.
  // We use a Set to handle multiple devices (phone, laptop) per student.
  const connections = new Map<string, Set<FastifyReply["raw"]>>();

  // Notification history: stores recent grades so students can catch up if they reconnect.
  const notificationsByStudent = new Map<string, GradeNotification[]>();

  // Background job: delete old notifications to prevent memory leaks.
  const ttlCleanup = setInterval(() => {
    const cutoff = new Date(Date.now() - MISSED_TTL_MS);
    for (const [studentId, list] of notificationsByStudent.entries()) {
      const kept = list.filter((n) => n.publishedAt > cutoff);
      if (kept.length === 0) notificationsByStudent.delete(studentId);
      else notificationsByStudent.set(studentId, kept);
    }
  }, TTL_CLEANUP_INTERVAL_MS);

  // Ensure we clear the interval when the server shuts down
  fastify.addHook("onClose", (_instance, done) => {
    clearInterval(ttlCleanup);
    done();
  });

  // --- SSE Endpoint: Students connect here to listen for updates ---
  fastify.get<{ Params: { studentId: string } }>(
    "/notifications/stream/:studentId",
    async (request, reply) => {
      const { studentId } = request.params;
      
      // Enforce connection limit (e.g., max 3 devices)
      let set = connections.get(studentId);
      if (set && set.size >= MAX_CONNECTIONS_PER_STUDENT) {
        return reply.status(429).send({
          error: "Too many connections",
          message: `Max ${MAX_CONNECTIONS_PER_STUDENT} connections per student`,
        });
      }

      // Switch to raw Node response for SSE streaming
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      
      // Flush headers immediately to establish the connection
      if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
        (res as unknown as { flushHeaders: () => void }).flushHeaders();
      }

      // Register this connection
      if (!set) {
        set = new Set();
        connections.set(studentId, set);
      }
      set.add(res);

      // Helper to safely write data; catches errors if client disconnects unexpectedly
      const send = (data: string) => {
        try {
          if (!res.writableEnded) res.write(data);
        } catch (err) {
          fastify.log.error({ err, studentId }, "SSE write error");
          cleanup();
        }
      };

      // Cleanup logic: remove connection from memory and close the stream.
      // This is critical to prevent memory leaks.
      const cleanup = () => {
        set?.delete(res);
        if (set?.size === 0) connections.delete(studentId);
        try {
          if (!res.writableEnded) res.end();
        } catch (_) {}
      };

      // Listen for client disconnects (closing tab, network loss)
      request.raw.on("close", cleanup);

      // Confirm connection to the client
      send(`data: ${JSON.stringify({ type: "connected", studentId })}\n\n`);

      // Heartbeat: send a comment line periodically to keep the connection alive
      // and detect dead connections faster.
      const keepalive = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(keepalive);
          return;
        }
        try {
          res.write(": keepalive\n\n");
        } catch (err) {
          fastify.log.error({ err, studentId }, "Keep-alive write error");
          clearInterval(keepalive);
          cleanup();
        }
      }, KEEPALIVE_INTERVAL_MS);
      
      request.raw.on("close", () => clearInterval(keepalive));

      // Important: We do NOT call reply.send() here. The connection remains open.
    }
  );

  // --- Publish Endpoint: Teachers post grades here ---
  fastify.post<{ Body: PublishBody }>("/grades/publish", async (request, reply) => {
    const body = request.body;
    if (!body?.assignmentId || body.grade == null) {
      return reply.status(400).send({ error: "Missing assignmentId or grade" });
    }

    // Normalize input to always be an array of student IDs
    const studentIds: string[] = body.studentIds ?? (body.studentId ? [body.studentId] : []);
    if (studentIds.length === 0) {
      return reply.status(400).send({ error: "Missing studentId or studentIds" });
    }

    const teacherComment = body.teacherComment;
    const assignmentId = body.assignmentId;
    const grade = body.grade;
    const publishedAt = new Date();

    // Deduplication: prevents sending duplicate notifications if the teacher 
    // accidentally includes the same studentId twice in the request array.
    const sentThisRequest = new Set<string>();
    let sent = 0;
    let stored = 0;

    for (const studentId of studentIds) {
      const id = `${studentId}:${assignmentId}:${publishedAt.getTime()}`;
      if (sentThisRequest.has(id)) continue;
      sentThisRequest.add(id);

      const notification: GradeNotification = {
        id,
        studentId,
        assignmentId,
        grade,
        teacherComment,
        publishedAt,
      };

      // 1. Store in history for offline students
      let list = notificationsByStudent.get(studentId);
      if (!list) {
        list = [];
        notificationsByStudent.set(studentId, list);
      }
      list.push(notification);
      stored += 1;

      // 2. Push to any currently connected devices
      const payload = `data: ${JSON.stringify(notification)}\n\n`;
      const activeConnections = connections.get(studentId);
      
      if (activeConnections) {
        for (const res of activeConnections) {
          try {
            if (!res.writableEnded) {
              res.write(payload);
              sent += 1;
            }
          } catch (err) {
            // If writing fails, assume connection is dead; remove it.
            fastify.log.error({ err, studentId }, "Failed to write notification to client");
            activeConnections.delete(res);
            try {
              if (!res.writableEnded) res.end();
            } catch (_) {}
          }
        }
      }
    }

    return reply.send({ ok: true, sent, stored });
  });

  // --- Missed Endpoint: Retrieve history ---
  // Used when a student reconnects to fetch grades they missed while offline.
  fastify.get<{
    Params: { studentId: string };
    Querystring: { since?: string };
  }>("/notifications/missed/:studentId", async (request, reply) => {
    const { studentId } = request.params;
    const { since: sinceParam } = request.query;
    
    let sinceDate: Date | undefined;
    if (sinceParam != null && sinceParam !== "") {
      // Support both timestamp (ms) and ISO string formats
      const parsed = /^\d+$/.test(sinceParam) ? Number(sinceParam) : new Date(sinceParam).getTime();
      if (Number.isFinite(parsed)) sinceDate = new Date(parsed);
    }

    const list = notificationsByStudent.get(studentId) ?? [];
    
    // Filter by date if 'since' was provided, otherwise return all history
    const notifications = sinceDate
      ? list.filter((n) => n.publishedAt >= sinceDate!)
      : list;
      
    return reply.send({ notifications });
  });
};

export default gradeNotificationsRoutes;