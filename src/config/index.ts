import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

function parseIntOrDefault(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val === "") return defaultVal;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultVal : parsed;
}

// Read version from package.json for user-agent string
const packageJsonPath = path.resolve(__dirname, "../../package.json");
const packageVersion: string = fs.existsSync(packageJsonPath)
  ? (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string }).version
  : "1.0.0";

export const config = {
  port: parseIntOrDefault(process.env.PORT, 3000),
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
    maxConcurrentAnalyses: parseIntOrDefault(process.env.MAX_CONCURRENT_ANALYSES, 3),
    rateLimitPerHour: parseIntOrDefault(process.env.RATE_LIMIT_PER_HOUR, 10),
    maxQueueSize: parseIntOrDefault(process.env.MAX_QUEUE_SIZE, 100),
  },

  timeouts: {
    cloneMs: parseIntOrDefault(process.env.CLONE_TIMEOUT_MS, 90000),
    restoreMs: parseIntOrDefault(process.env.RESTORE_TIMEOUT_MS, 120000),
    parseMs: parseIntOrDefault(process.env.PARSE_TIMEOUT_MS, 120000),
    prMs: parseIntOrDefault(process.env.PR_TIMEOUT_MS, 30000),
    jobMs: parseIntOrDefault(process.env.JOB_TIMEOUT_MS, 600000),
  },

  userAgent: `ASTronaut/${packageVersion}`,

  dbPoolMax: parseIntOrDefault(process.env.DB_POOL_MAX, 10),
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

  // Fatal if private key file doesn't exist
  if (!fs.existsSync(config.github.privateKeyPath)) {
    console.error(
      `FATAL: GitHub App private key file not found at: ${config.github.privateKeyPath}`
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
