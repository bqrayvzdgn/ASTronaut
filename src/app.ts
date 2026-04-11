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
      req.rawBody = buf;
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
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info({ signal }, "Shutdown already in progress — ignoring");
    return;
  }
  isShuttingDown = true;

  logger.info({ signal }, "Shutdown signal received — draining");

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Wait for active jobs to finish (with timeout)
  const drainPromise = analysisQueue.drain();
  let drainTimer: NodeJS.Timeout;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    drainTimer = setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS);
    drainTimer.unref();
  });
  const result = await Promise.race([
    drainPromise.then(() => "drained" as const),
    timeoutPromise,
  ]);
  clearTimeout(drainTimer!);

  if (result === "timeout") {
    logger.warn(
      { activeJobs: analysisQueue.getActiveCount(), queueLength: analysisQueue.getQueueLength() },
      "Drain timeout reached — forcing shutdown with active jobs"
    );
  }

  clearEvictionInterval();

  // Brief grace period for in-flight DB writes from finishing jobs
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await closeDatabase();

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
