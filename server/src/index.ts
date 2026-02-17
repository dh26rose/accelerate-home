import Fastify from "fastify";
import cors from "@fastify/cors";
import gradeNotificationsRoutes from "./routes/grade-notifications.js";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });

fastify.get("/health", async (_request, reply) => {
  return reply.send({ status: "ok" });
});

await fastify.register(gradeNotificationsRoutes);

const port = Number(process.env.PORT) || 2022;
await fastify.listen({ port, host: "0.0.0.0" });
console.log(`Server listening on http://localhost:${port}`);
