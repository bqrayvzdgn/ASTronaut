import dotenv from "dotenv";
import path from "path";

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  databaseUrl: process.env.DATABASE_URL!,

  github: {
    appId: process.env.GITHUB_APP_ID!,
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  },

  dotnetAnalyzerPath:
    process.env.DOTNET_ANALYZER_PATH ||
    path.resolve("./analyzer/bin/Release/net8.0/ASTronautAnalyzer.dll"),

  limits: {
    maxConcurrentAnalyses: parseInt(
      process.env.MAX_CONCURRENT_ANALYSES || "3",
      10
    ),
    rateLimitPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || "10", 10),
  },

  timeouts: {
    cloneMs: parseInt(process.env.CLONE_TIMEOUT_MS || "30000", 10),
    restoreMs: parseInt(process.env.RESTORE_TIMEOUT_MS || "60000", 10),
    parseMs: parseInt(process.env.PARSE_TIMEOUT_MS || "60000", 10),
    prMs: parseInt(process.env.PR_TIMEOUT_MS || "15000", 10),
  },

  logLevel: process.env.LOG_LEVEL || "info",
} as const;
