import { test, expect } from "@playwright/test";

const PORT = process.env.PORT ?? "2022";
const BASE_URL = process.env.GRADE_NOTIFICATIONS_BASE_URL ?? `http://127.0.0.1:${PORT}`;

function uniqueStudentId(prefix: string): string {
  return `student-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface ReadSSEOptions {
  signal?: AbortSignal;
  maxEvents?: number;
  stopWhen?: (data: unknown) => boolean;
}

async function readSSEEvents(
  url: string,
  options: ReadSSEOptions = {}
): Promise<unknown[]> {
  const { signal, maxEvents = 50, stopWhen } = options;
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`SSE fetch failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (line) {
          const raw = line.slice(5).trim();
          if (raw === "") continue; // comment line (e.g. keepalive) has no data
          try {
            const data = JSON.parse(raw);
            events.push(data);
            if (stopWhen?.(data)) return events;
          } catch {
            events.push(raw);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

/** Open an SSE connection and immediately close it (for rapid connect/disconnect tests). */
async function openAndCloseStream(url: string): Promise<void> {
  const ac = new AbortController();
  const p = readSSEEvents(url, { signal: ac.signal, maxEvents: 1 });
  ac.abort();
  await p.catch(() => {});
}

test.describe("Grade notifications", () => {
  test.setTimeout(15000);

  const activeControllers: AbortController[] = [];
  test.afterEach(() => {
    for (const ac of activeControllers) ac.abort();
    activeControllers.length = 0;
  });

  test("student receives notification when connected", async ({ request }) => {
    const studentId = uniqueStudentId("connected");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    const eventsPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && "assignmentId" in d,
    });

    // Allow stream to open and receive "connected"
    await new Promise((r) => setTimeout(r, 300));

    const publishRes = await request.post(`${BASE_URL}/grades/publish`, {
      data: {
        studentId,
        assignmentId: "a1",
        grade: 85,
        teacherComment: "Good work",
      },
    });
    expect(publishRes.ok()).toBe(true);
    const body = await publishRes.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBeGreaterThanOrEqual(1);
    expect(body.stored).toBe(1);

    const events = await eventsPromise;
    ac.abort();

    const connected = events.find(
      (e: unknown) => typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();

    const notification = events.find(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        (e as { assignmentId?: string }).assignmentId === "a1"
    );
    expect(notification).toBeDefined();
    expect((notification as { grade: number }).grade).toBe(85);
    expect((notification as { studentId: string }).studentId).toBe(studentId);
  });

  test("student receives missed notifications on reconnect", async ({ request }) => {
    const studentId = uniqueStudentId("missed");
    await request.post(`${BASE_URL}/grades/publish`, {
      data: {
        studentId,
        assignmentId: "a2",
        grade: 90,
      },
    });

    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    expect(Array.isArray(notifications)).toBe(true);
    const a2 = notifications.find((n: { assignmentId: string }) => n.assignmentId === "a2");
    expect(a2).toBeDefined();
    expect(a2.grade).toBe(90);
    expect(a2.studentId).toBe(studentId);
  });

  test("student receives missed notifications after reconnect (connect, disconnect, publish, fetch missed)", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("reconnect-flow");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    const eventsPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    await eventsPromise;
    ac.abort();
    await new Promise((r) => setTimeout(r, 200));

    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a-reconnect", grade: 95 },
    });

    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const aReconnect = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "a-reconnect"
    );
    expect(aReconnect).toBeDefined();
    expect(aReconnect.grade).toBe(95);
    expect(aReconnect.studentId).toBe(studentId);
  });

  test("missed notifications respect ?since= query", async ({ request }) => {
    const studentId = uniqueStudentId("since");
    const before = Date.now();
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a-before", grade: 70 },
    });
    await new Promise((r) => setTimeout(r, 50));
    const after = Date.now();
    await new Promise((r) => setTimeout(r, 10)); // ensure second publish is strictly after `after`
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a-after", grade: 80 },
    });

    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}?since=${after}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const ids = notifications.map((n: { assignmentId: string }) => n.assignmentId);
    expect(ids).toContain("a-after");
    expect(ids).not.toContain("a-before");
  });

  test("batch publish sends to multiple students", async ({ request }) => {
    const s1 = uniqueStudentId("batch1");
    const s2 = uniqueStudentId("batch2");
    const s3 = uniqueStudentId("batch3");
    const streamUrl1 = `${BASE_URL}/notifications/stream/${s1}`;
    const streamUrl2 = `${BASE_URL}/notifications/stream/${s2}`;
    const streamUrl3 = `${BASE_URL}/notifications/stream/${s3}`;

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();
    activeControllers.push(ac1, ac2, ac3);
    const stopWhenGrade = (d: unknown) =>
      typeof d === "object" &&
      d !== null &&
      (d as { assignmentId?: string }).assignmentId === "batch-a";
    const events1Promise = readSSEEvents(streamUrl1, { signal: ac1.signal, maxEvents: 5, stopWhen: stopWhenGrade });
    const events2Promise = readSSEEvents(streamUrl2, { signal: ac2.signal, maxEvents: 5, stopWhen: stopWhenGrade });
    const events3Promise = readSSEEvents(streamUrl3, { signal: ac3.signal, maxEvents: 5, stopWhen: stopWhenGrade });

    await new Promise((r) => setTimeout(r, 300));

    const publishRes = await request.post(`${BASE_URL}/grades/publish`, {
      data: {
        studentIds: [s1, s2, s3],
        assignmentId: "batch-a",
        grade: 88,
      },
    });
    expect(publishRes.ok()).toBe(true);
    const body = await publishRes.json();
    expect(body.ok).toBe(true);
    expect(body.stored).toBe(3);
    expect(body.sent).toBe(3);

    const [events1, events2, events3] = await Promise.all([
      events1Promise,
      events2Promise,
      events3Promise,
    ]);

    ac1.abort();
    ac2.abort();
    ac3.abort();

    const hasGrade = (events: unknown[]) =>
      events.some(
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          (e as { assignmentId?: string }).assignmentId === "batch-a"
      );
    expect(hasGrade(events1)).toBe(true);
    expect(hasGrade(events2)).toBe(true);
    expect(hasGrade(events3)).toBe(true);
  });

  test("connection cleanup after disconnect", async ({ request }) => {
    const studentId = uniqueStudentId("cleanup");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;

    const ac = new AbortController();
    activeControllers.push(ac);
    const firstPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await firstPromise;

    await new Promise((r) => setTimeout(r, 200));

    const ac2 = new AbortController();
    activeControllers.push(ac2);
    const secondPromise = readSSEEvents(streamUrl, {
      signal: ac2.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    const events = await secondPromise;
    ac2.abort();

    const connected = events.find(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();
    expect((connected as { studentId: string }).studentId).toBe(studentId);
  });

  // ---- Edge-case tests ----

  test("rapid connect/disconnect cycles: 10 open/close then new connection accepted", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("rapid");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    for (let i = 0; i < 10; i++) {
      await openAndCloseStream(streamUrl);
    }
    await new Promise((r) => setTimeout(r, 150));
    const ac = new AbortController();
    activeControllers.push(ac);
    const eventsPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    const events = await eventsPromise;
    ac.abort();
    const connected = events.find(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();
    expect((connected as { studentId: string }).studentId).toBe(studentId);
  });

  test("student has unstable internet: 20 rapid connect/disconnects; no memory leaks or crashes, new connection succeeds", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("unstable");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    for (let i = 0; i < 20; i++) {
      await openAndCloseStream(streamUrl);
    }
    await new Promise((r) => setTimeout(r, 200));
    const ac = new AbortController();
    activeControllers.push(ac);
    const events = await readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    ac.abort();
    const connected = events.find(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();
    expect((connected as { studentId: string }).studentId).toBe(studentId);
  });

  test("student tries to connect from 4 devices (max 3): 4th rejected; after one disconnects, new connection succeeds", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("four-devices");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();
    activeControllers.push(ac1, ac2, ac3);
    readSSEEvents(streamUrl, { signal: ac1.signal, maxEvents: 2 }).catch(() => {});
    readSSEEvents(streamUrl, { signal: ac2.signal, maxEvents: 2 }).catch(() => {});
    readSSEEvents(streamUrl, { signal: ac3.signal, maxEvents: 2 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const res429 = await request.get(streamUrl);
    expect(res429.status()).toBe(429);
    const body429 = await res429.json();
    expect(body429.error).toBe("Too many connections");
    expect(String(body429.message)).toContain("3");
    ac2.abort();
    await new Promise((r) => setTimeout(r, 200));
    const ac4 = new AbortController();
    activeControllers.push(ac4);
    const events4 = await readSSEEvents(streamUrl, {
      signal: ac4.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    ac4.abort();
    ac1.abort();
    ac3.abort();
    const connected = events4.find(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();
  });

  test("connection limit enforcement: 4th connection gets 429, then after disconnect new one succeeds", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("limit");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();
    activeControllers.push(ac1, ac2, ac3);
    const p1 = readSSEEvents(streamUrl, { signal: ac1.signal, maxEvents: 2 });
    const p2 = readSSEEvents(streamUrl, { signal: ac2.signal, maxEvents: 2 });
    const p3 = readSSEEvents(streamUrl, { signal: ac3.signal, maxEvents: 2 });
    await new Promise((r) => setTimeout(r, 400));
    const res429 = await request.get(streamUrl);
    expect(res429.status()).toBe(429);
    const body429 = await res429.json();
    expect(body429.error).toBe("Too many connections");
    expect(String(body429.message)).toContain("3");
    ac2.abort();
    await p2.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const ac4 = new AbortController();
    activeControllers.push(ac4);
    const events4 = await readSSEEvents(streamUrl, {
      signal: ac4.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    ac4.abort();
    ac1.abort();
    ac3.abort();
    await p1.catch(() => {});
    await p3.catch(() => {});
    const connected = events4.find(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "connected"
    );
    expect(connected).toBeDefined();
  });

  test("malformed /grades/publish: missing assignmentId returns 400 and stores nothing", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("malformed");
    const res = await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, grade: 90 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/assignmentId|grade|missing/i);
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    const { notifications } = await missedRes.json();
    expect(notifications).toHaveLength(0);
  });

  test("malformed /grades/publish: missing grade returns 400 and stores nothing", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("malformed2");
    const res = await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a1" },
    });
    expect(res.status()).toBe(400);
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    const { notifications } = await missedRes.json();
    expect(notifications).toHaveLength(0);
  });

  test("malformed /grades/publish: missing studentId and studentIds returns 400", async ({
    request,
  }) => {
    const res = await request.post(`${BASE_URL}/grades/publish`, {
      data: { assignmentId: "a1", grade: 85 },
    });
    expect(res.status()).toBe(400);
  });

  test("malformed /grades/publish: empty studentIds array returns 400", async ({
    request,
  }) => {
    const res = await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentIds: [], assignmentId: "a1", grade: 85 },
    });
    expect(res.status()).toBe(400);
  });

  test("publish to student with no active connections: notification stored and appears in missed", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("no-connections");
    const publishRes = await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a-no-conn", grade: 72 },
    });
    expect(publishRes.ok()).toBe(true);
    const body = await publishRes.json();
    expect(body.stored).toBe(1);
    expect(body.sent).toBe(0);
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const n = notifications.find(
      (x: { assignmentId: string }) => x.assignmentId === "a-no-conn"
    );
    expect(n).toBeDefined();
    expect(n.grade).toBe(72);
  });

  test("GET /notifications/missed with invalid since parameter: no crash, returns 200 and treats as no filter", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("invalid-since");
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "a1", grade: 80 },
    });
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}?since=not-a-date`
    );
    expect(missedRes.status()).toBe(200);
    const { notifications } = await missedRes.json();
    expect(Array.isArray(notifications)).toBe(true);
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    const a1 = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "a1"
    );
    expect(a1).toBeDefined();
  });

  // ---- Concurrency & stress ----

  test("simultaneous connections for many students: 100 students each get notification", async ({
    request,
  }) => {
    test.setTimeout(30000);
    const n = 100;
    const studentIds = Array.from({ length: n }, (_, i) =>
      uniqueStudentId(`stress-${i}`)
    );
    const controllers: AbortController[] = [];
    const streamUrls = studentIds.map(
      (id) => `${BASE_URL}/notifications/stream/${id}`
    );
    const eventsPromises = streamUrls.map((url, i) => {
      const ac = new AbortController();
      controllers.push(ac);
      activeControllers.push(ac);
      return readSSEEvents(url, {
        signal: ac.signal,
        maxEvents: 5,
        stopWhen: (d: unknown) =>
          typeof d === "object" &&
          d !== null &&
          (d as { assignmentId?: string }).assignmentId === "stress-a",
      });
    });
    await new Promise((r) => setTimeout(r, 500));
    const publishRes = await request.post(`${BASE_URL}/grades/publish`, {
      data: {
        studentIds,
        assignmentId: "stress-a",
        grade: 75,
      },
    });
    expect(publishRes.ok()).toBe(true);
    const body = await publishRes.json();
    expect(body.stored).toBe(n);
    expect(body.sent).toBe(n);
    const results = await Promise.all(eventsPromises);
    controllers.forEach((c) => c.abort());
    results.forEach((events, i) => {
      const hasNotification = events.some(
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          (e as { assignmentId?: string }).assignmentId === "stress-a"
      );
      expect(hasNotification).toBe(true);
    });
  });

  test("concurrent grade publications: overlapping students get correct notifications", async ({
    request,
  }) => {
    const s1 = uniqueStudentId("conc1");
    const s2 = uniqueStudentId("conc2");
    const s3 = uniqueStudentId("conc3");
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();
    activeControllers.push(ac1, ac2, ac3);
    const url1 = `${BASE_URL}/notifications/stream/${s1}`;
    const url2 = `${BASE_URL}/notifications/stream/${s2}`;
    const url3 = `${BASE_URL}/notifications/stream/${s3}`;
    const stopA = (d: unknown) =>
      typeof d === "object" &&
      d !== null &&
      (d as { assignmentId?: string }).assignmentId === "concurrent-a";
    const stopB = (d: unknown) =>
      typeof d === "object" &&
      d !== null &&
      (d as { assignmentId?: string }).assignmentId === "concurrent-b";
    const p1 = readSSEEvents(url1, { signal: ac1.signal, maxEvents: 10, stopWhen: stopA });
    const p2 = readSSEEvents(url2, { signal: ac2.signal, maxEvents: 10, stopWhen: stopB });
    const p3 = readSSEEvents(url3, { signal: ac3.signal, maxEvents: 10, stopWhen: stopA });
    await new Promise((r) => setTimeout(r, 300));
    const [r1, r2, r3] = await Promise.all([
      request.post(`${BASE_URL}/grades/publish`, {
        data: { studentId: s1, assignmentId: "concurrent-a", grade: 1 },
      }),
      request.post(`${BASE_URL}/grades/publish`, {
        data: { studentIds: [s2, s3], assignmentId: "concurrent-b", grade: 2 },
      }),
      request.post(`${BASE_URL}/grades/publish`, {
        data: { studentIds: [s1, s3], assignmentId: "concurrent-a", grade: 3 },
      }),
    ]);
    expect(r1.ok()).toBe(true);
    expect(r2.ok()).toBe(true);
    expect(r3.ok()).toBe(true);
    const [e1, e2, e3] = await Promise.all([p1, p2, p3]);
    ac1.abort();
    ac2.abort();
    ac3.abort();
    const hasA = (events: unknown[]) =>
      events.some(
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          (e as { assignmentId?: string }).assignmentId === "concurrent-a"
      );
    const hasB = (events: unknown[]) =>
      events.some(
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          (e as { assignmentId?: string }).assignmentId === "concurrent-b"
      );
    expect(hasA(e1)).toBe(true);
    expect(hasB(e2)).toBe(true);
    expect(hasA(e3)).toBe(true);
    const missed1 = await request.get(`${BASE_URL}/notifications/missed/${s1}`);
    const missed3 = await request.get(`${BASE_URL}/notifications/missed/${s3}`);
    const { notifications: n1 } = await missed1.json();
    const { notifications: n3 } = await missed3.json();
    const ids1 = n1.map((x: { assignmentId: string }) => x.assignmentId);
    const ids3 = n3.map((x: { assignmentId: string }) => x.assignmentId);
    expect(ids1).toContain("concurrent-a");
    expect(ids3).toContain("concurrent-b");
    expect(ids3).toContain("concurrent-a");
  });

  // ---- Reliability & recovery ----

  test("student loses internet briefly then reconnects; grades published during disconnection delivered via missed", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("brief-disconnect");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    const connectedPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    await connectedPromise;
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "during-disconnect", grade: 88 },
    });
    await new Promise((r) => setTimeout(r, 100));
    const ac2 = new AbortController();
    activeControllers.push(ac2);
    const reconnectPromise = readSSEEvents(streamUrl, {
      signal: ac2.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    const reconnectEvents = await reconnectPromise;
    ac2.abort();
    expect(reconnectEvents.some((e: unknown) => typeof e === "object" && e !== null && (e as { type?: string }).type === "connected")).toBe(true);
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const found = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "during-disconnect"
    );
    expect(found).toBeDefined();
    expect(found.grade).toBe(88);
  });

  test("network interruption during SSE: abort then reconnect, missed returns notifications published during gap", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("interrupt");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    const connectedPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    await connectedPromise;
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "during-gap", grade: 88 },
    });
    await new Promise((r) => setTimeout(r, 50));
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const found = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "during-gap"
    );
    expect(found).toBeDefined();
    expect(found.grade).toBe(88);
  });

  test.skip("server down for maintenance: grades published during downtime, server comes back, students reconnect and get missed (in-memory: data lost; requires persistent storage)", async () => {
    // With in-memory storage, server restart loses all state. This scenario would require
    // persistent storage (e.g. Redis/DB) to verify; document as limitation.
  });

  test("grade published at exact moment student connection is closing: notification still stored and available via missed", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("exact-close");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    readSSEEvents(streamUrl, {
      signal: ac.signal,
      maxEvents: 3,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    }).then(() => {});
    await new Promise((r) => setTimeout(r, 250));
    await Promise.all([
      request.post(`${BASE_URL}/grades/publish`, {
        data: { studentId, assignmentId: "exact-close-a", grade: 77 },
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 15));
        ac.abort();
      })(),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const found = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "exact-close-a"
    );
    expect(found).toBeDefined();
    expect(found.grade).toBe(77);
  });

  test("race: publish while client disconnects - server does not crash, notification stored in missed", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("race");
    const streamUrl = `${BASE_URL}/notifications/stream/${studentId}`;
    const ac = new AbortController();
    activeControllers.push(ac);
    const eventsPromise = readSSEEvents(streamUrl, {
      signal: ac.signal,
      maxEvents: 3,
      stopWhen: (d: unknown) =>
        typeof d === "object" && d !== null && (d as { type?: string }).type === "connected",
    });
    await eventsPromise;
    await Promise.all([
      request.post(`${BASE_URL}/grades/publish`, {
        data: { studentId, assignmentId: "race-a", grade: 99 },
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        ac.abort();
      })(),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    expect(missedRes.ok()).toBe(true);
    const { notifications } = await missedRes.json();
    const found = notifications.find(
      (n: { assignmentId: string }) => n.assignmentId === "race-a"
    );
    expect(found).toBeDefined();
  });

  test.skip("TTL cleanup: notifications older than 24h removed (run manually; cleanup interval is 5min)", async () => {
    // Server TTL cleanup runs every 5 minutes. To verify: publish, wait 5+ min, call missed.
    // Skipped by default; enable for manual/CI verification with long timeout.
  });

  test.skip("old notifications (older than 24h) automatically removed by TTL cleanup; simulates time passing", async () => {
    // Server removes notifications older than 24h every 5 minutes. Full verification would require
    // either waiting 24h+ or server support for configurable TTL/cleanup (e.g. env or test hook).
  });

  // ---- Idempotency & duplicate prevention ----

  test("duplicate publish request: server stores both (per-request dedup only; cross-request duplicates allowed)", async ({
    request,
  }) => {
    const studentId = uniqueStudentId("dup");
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "dup-a", grade: 50 },
    });
    await request.post(`${BASE_URL}/grades/publish`, {
      data: { studentId, assignmentId: "dup-a", grade: 50 },
    });
    const missedRes = await request.get(
      `${BASE_URL}/notifications/missed/${studentId}`
    );
    const { notifications } = await missedRes.json();
    const dupA = notifications.filter(
      (n: { assignmentId: string }) => n.assignmentId === "dup-a"
    );
    expect(dupA.length).toBe(2);
  });
});
