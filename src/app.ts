import express from "express";
import pinoHttp from "pino-http";
import { config, validateConfig } from "./config";
import { logger } from "./utils/logger";
import { clearEvictionInterval } from "./utils/rateLimiter";
import routes from "./api/routes";
import { initializePipeline } from "./pipeline";
import { analysisQueue } from "./queue/analysisQueue";
import { closeDatabase } from "./db/connection";

validateConfig();

const app = express();

// Raw body needed for webhook signature verification
app.use(
  express.json({
    verify: (req: express.Request, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

app.use(pinoHttp({ logger }));

app.use(routes);

const server = app.listen(config.port, async () => {
  logger.info({ port: config.port }, "ASTronaut server started");
  await initializePipeline();
});

// Graceful shutdown
const DRAIN_TIMEOUT_MS = 30_000;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown signal received — draining");

  server.close();

  // Wait for active jobs to finish (with timeout)
  const drainPromise = analysisQueue.drain();
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, DRAIN_TIMEOUT_MS)
  );
  await Promise.race([drainPromise, timeout]);

  clearEvictionInterval();
  await closeDatabase();

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
