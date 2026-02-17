# Accelerate Home – Real-Time Grade Notification System

A production‑ready implementation of a real‑time grade notification system using **Fastify SSE**, **TypeScript**, and **Playwright**.  

---

## 📦 Deliverables

| Part | File | Description |
|------|------|-------------|
| Part 1 – Implementation | [`server/src/routes/grade-notifications.ts`](server/src/routes/grade-notifications.ts) | SSE connection management, grade publication, missed notifications. |
| Part 1 – Tests | [`tests-e2e/tests/grade-notifications.test.ts`](tests-e2e/tests/grade-notifications.test.ts) | 4 required test cases + edge‑case, concurrency, and reliability tests. |
| Part 2 – Architecture | [`architecture-decision.md`](architecture-decision.md) | Feature flag system analysis and recommendation. |
| Configuration | [`package.json`](package.json) | Dependencies and scripts. |
| Documentation | `README.md` | This file. |

---

## 🚀 How to Run the Server

### Prerequisites
- Node.js 18+ and npm installed.

### Start the server
From the repository root:

```bash
npm install          # install dependencies
npm run dev          # start the Fastify server on port 2022
```

The server listens on **port 2022** (override with `PORT` environment variable).  
A health check is available at [`http://localhost:2022/health`](http://localhost:2022/health).

### Available endpoints
- **SSE stream**  
  `GET /notifications/stream/:studentId`  
  Opens a persistent connection for a student.
- **Publish grades**  
  `POST /grades/publish`  
  Accepts a single `studentId` or array `studentIds` with `assignmentId`, `grade`, and optional `teacherComment`.
- **Missed notifications**  
  `GET /notifications/missed/:studentId?since=<timestamp>`  
  Returns all notifications stored for that student (optionally filtered by a timestamp).

---

## 🧪 How to Run the Tests

The test suite uses **Playwright** and automatically starts the server via its `webServer` configuration.

```bash
npm test                 # run all tests
npm run test:grades      # run only the grade‑notification tests
```

If you prefer to run Playwright manually:

```bash
npx playwright test grade-notifications --config=tests-e2e/playwright.config.ts
```

---

## 🧪 How to Run the Tests

The test suite uses **Playwright** and automatically starts the server via its `webServer` configuration.

```bash
npm test                 # run all tests
npm run test:grades      # run only the grade‑notification tests
```

If you prefer to run Playwright manually:

```bash
npx playwright test grade-notifications --config=tests-e2e/playwright.config.ts
```

Overriding the server port or base URL

The server listens on port **2022** by default. You can change the port for development or testing using the `PORT` environment variable.  
You can also specify a custom base URL with `GRADE_NOTIFICATIONS_BASE_URL` if the server is already running elsewhere.

**Bash (Linux/macOS):**  
```bash
PORT=3030 npm run dev          # start server on port 3030
PORT=3030 npm test              # run tests against port 3030
GRADE_NOTIFICATIONS_BASE_URL=http://localhost:2030 npm test   # custom URL
```

**PowerShell (Windows):**  
Do not copy a leading backtick. Use one of these exactly:

```powershell
$env:PORT = "3030"; npm run dev
$env:PORT = "3030"; npm test
```

For a custom base URL (e.g., server already on port 2030):

```powershell
$env:GRADE_NOTIFICATIONS_BASE_URL = "http://localhost:2030"
npm test
```

The Playwright configuration and tests respect `PORT` (if set) and `GRADE_NOTIFICATIONS_BASE_URL`; otherwise they default to `http://127.0.0.1:2022`.

### Best practice: workflow and port in use

- **Running tests:** Run `npm test`. You do **not** need to start or terminate the server yourself; Playwright starts and is responsible for tearing it down when the run finishes.
- **Running the server for a demo:** Run `npm run dev:server` in a terminal. If you get **"address already in use"** on port 2022 (e.g. the test run left the server running), you can:
  - **Reuse it** — the server may still be up; use `http://127.0.0.1:2022/health` to check, or
  - **Start on another port:** e.g. `PORT=2023 npm run dev:server` (PowerShell: `$env:PORT=2023; npm run dev:server`), then use `http://127.0.0.1:2023/health`, or
  - **Free port 2022:** find the process (e.g. `netstat -ano | findstr :2022`), then `taskkill /PID <pid> /F`, and run `npm run dev:server` again.

---

### Tests included
- **Core tests** (required): live notification, missed on reconnect, batch publish, connection cleanup.
- **Edge‑case tests**: malformed requests, connection limits, rapid connect/disconnect.
- **Concurrency tests**: 100 simultaneous connections, overlapping grade publications.
- **Reliability tests**: network interruption, race conditions (publish during disconnect).

All tests pass; skipped tests are noted where in‑memory limitations apply.

---

## 🧠 SSE Implementation Approach

### Connection management
- Each student is mapped to a `Set` of active SSE responses (`Map<string, Set<ServerResponse>>`).
- **Limit:** maximum **3 concurrent connections per student** (HTTP 429 when exceeded).
- **Keep‑alive:** a comment line (`: keepalive\n\n`) is sent every 20 seconds to keep the connection alive and detect dead clients.

### Disconnect cleanup
- On `request.raw.on("close")`, the response is removed from the map. If the set becomes empty, the student’s entry is deleted.
- The keep‑alive interval is cleared, and the response is ended (if still writable).
- **Write‑error handling:** if a write to a socket fails, that connection is removed immediately to prevent memory leaks.

### Missed notifications
- All published grades are stored **in‑memory** for **24 hours** (`notificationsByStudent` map).
- A background job (`ttlCleanup`) runs every 5 minutes to purge entries older than 24h.
- The endpoint `GET /notifications/missed/:studentId?since=<timestamp>` returns stored notifications after the given timestamp (or all if no `since`).

### Deduplication
- **Per‑request only** – a `Set` prevents duplicate notifications within the same publish batch. Cross‑request duplicates are allowed; a persistent store would be needed for global dedup.

### Why SSE?
- Simpler than WebSockets for one‑way server‑to‑client communication.
- Native browser support with automatic reconnection.
- HTTP/2 compatible and works through standard load balancers.

---

## 📌 Assumptions

- **In‑memory only** – all state (connections, notifications) lives in the server’s memory. Suitable for a take‑home but not production.
- **Single process** – the system runs on one Node.js instance.
- **No authentication** – endpoints are unprotected for simplicity.
- **Notification IDs** – generated as `${studentId}:${assignmentId}:${timestamp}`.

---

## 💭 Reflection

### Technical decisions in Part 1
I chose SSE over WebSockets because the requirement is one‑way (server pushes grades); SSE is simpler, has built‑in reconnection, and avoids the complexity of a bidirectional protocol. In‑memory maps keep the project self‑contained while still demonstrating production‑grade concerns like connection limits, cleanup, and TTL‑based history. The keep‑alive mechanism and error handling on writes make the system robust against flaky networks and abrupt disconnects.

### What I would add with more time
- **Persistence:** Replace in‑memory storage with Redis to survive restarts and enable horizontal scaling.
- **Authentication:** Protect the stream and publish endpoints with JWT tokens.
- **Monitoring:** Expose metrics (active connections, notification latency) for Prometheus.
- **Client demo:** A simple Next.js page that subscribes to the stream and displays real‑time grades.

### Scaling to 100,000 concurrent connections
To handle 100k concurrent connections, a single‑node, in‑memory architecture would be insufficient. I would:
1. **Horizontal scaling** with multiple server instances behind a load balancer.
2. **Shared state** using Redis: store active connection references per student (with a short TTL) and use Redis Pub/Sub to broadcast grade publications to all instances.
3. **Sticky sessions** (or a consistent hash) to ensure a student always connects to the same instance, reducing cross‑instance chatter.
4. **SSE gateway** – consider a dedicated edge layer (e.g., Cloudflare Workers, AWS Lambda@Edge) that can handle millions of long‑lived connections and forward events to origin servers.
5. If bidirectional communication becomes necessary, evaluate WebSockets with a managed service (Pusher, Ably) or a WebSocket gateway that scales independently.

---

## 📚 Additional Documentation

- [Architecture Decision: Feature Flag System](architecture-decision.md) – a detailed analysis of three approaches for gradual rollout, with a recommendation and operational considerations.

---