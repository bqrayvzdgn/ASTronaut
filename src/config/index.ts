import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

// Read version from package.json for user-agent string
const packageJsonPath = path.resolve(__dirname, "../../package.json");
const packageVersion: string = fs.existsSync(packageJsonPath)
  ? (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string }).version
  : "1.0.0";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  databaseUrl: process.env.DATABASE_URL || "",

  github: {
    appId: process.env.GITHUB_APP_ID || "",
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  },

  dotnetAnalyzerPath:
    process.env.DOTNET_ANALYZER_PATH ||
    path.resolve("./analyzers/dotnet/bin/Release/net8.0/ASTronautAnalyzer.dll"),

  ginAnalyzerPath:
    process.env.GIN_ANALYZER_PATH ||
    path.resolve("./analyzers/gin/bin/gin-analyzer"),

  limits: {
    maxConcurrentAnalyses: parseInt(
      process.env.MAX_CONCURRENT_ANALYSES || "3",
      10
    ),
    rateLimitPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || "10", 10),
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || "100", 10),
  },

  timeouts: {
    cloneMs: parseInt(process.env.CLONE_TIMEOUT_MS || "90000", 10),
    restoreMs: parseInt(process.env.RESTORE_TIMEOUT_MS || "120000", 10),
    parseMs: parseInt(process.env.PARSE_TIMEOUT_MS || "120000", 10),
    prMs: parseInt(process.env.PR_TIMEOUT_MS || "30000", 10),
    jobMs: parseInt(process.env.JOB_TIMEOUT_MS || "600000", 10),
  },

  userAgent: `ASTronaut/${packageVersion}`,

  dbPoolMax: parseInt(process.env.DB_POOL_MAX || "10", 10),
  logLevel: process.env.LOG_LEVEL || "info",
} as const;

export function validateConfig(): void {
  const required: Array<{ name: string; value: string }> = [
    { name: "DATABASE_URL", value: config.databaseUrl },
    { name: "GITHUB_APP_ID", value: config.github.appId },
    { name: "GITHUB_APP_PRIVATE_KEY_PATH", value: config.github.privateKeyPath },
    { name: "GITHUB_WEBHOOK_SECRET", value: config.github.webhookSecret },
  ];

  const missing = required.filter((r) => !r.value).map((r) => r.name);

  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required environment variables: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  // Warn (non-fatal) if .NET analyzer DLL is missing
  if (!fs.existsSync(config.dotnetAnalyzerPath)) {
    console.warn(
      `WARNING: .NET analyzer not found at ${config.dotnetAnalyzerPath}. ASP.NET analysis will fail.`
    );
  }

  // Warn (non-fatal) if Gin analyzer binary is missing
  if (!fs.existsSync(config.ginAnalyzerPath)) {
    console.warn(
      `WARNING: Gin analyzer not found at ${config.ginAnalyzerPath}. Gin analysis will fail.`
    );
  }
}
