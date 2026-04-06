import express from "express";
import pinoHttp from "pino-http";
import { config } from "./config";
import { logger } from "./utils/logger";
import routes from "./api/routes";
import { initializePipeline } from "./pipeline";

const app = express();

initializePipeline();

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

app.listen(config.port, () => {
  logger.info({ port: config.port }, "ASTronaut server started");
});

export default app;
