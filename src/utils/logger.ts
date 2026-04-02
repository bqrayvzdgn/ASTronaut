import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export function createChildLogger(context: {
  owner?: string;
  repo?: string;
  commitSha?: string;
}) {
  return logger.child(context);
}
