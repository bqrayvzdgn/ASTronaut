import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger";
import { ParseResult, RouteInfo, ParamInfo, PropertyInfo, ResponseInfo, ParseError } from "./types";

const execFileAsync = promisify(execFile);

export const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_LOG_OUTPUT = 1000; // Max chars logged from subprocess output

export function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + "... (truncated)" : s;
}

export function normalizeHttpMethod(method: string): RouteInfo["method"] {
  const upper = method.toUpperCase();
  const valid = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
  type ValidMethod = (typeof valid)[number];
  if (valid.includes(upper as ValidMethod)) {
    return upper as RouteInfo["method"];
  }
  return "GET";
}

interface ExternalRouteInfo {
  path: string;
  method: string;
  controller: string | null;
  routePrefix: string | null;
  params: Array<{
    name: string;
    in: string;
    type: string;
    required: boolean;
  }>;
  requestBody: {
    type: string;
    contentType?: string;
    properties: Array<{
      name: string;
      type: string;
      required: boolean;
    }>;
  } | null;
  responses: Array<{
    status: number;
    type: string | null;
    properties: Array<{
      name: string;
      type: string;
      required: boolean;
    }>;
  }>;
  auth: string | null;
  middleware: string[];
  description: string | null;
  source: string;
}

interface ExternalParseResult {
  routes: ExternalRouteInfo[];
  errors: Array<{
    file: string;
    reason: string;
  }>;
}

export interface ExternalAnalyzerConfig {
  command: string;
  args: string[];
  label: string;
  timeoutMs: number;
  repoPath: string;
}

export async function runExternalAnalyzer(cfg: ExternalAnalyzerConfig): Promise<ParseResult> {
  const { command, args, label, timeoutMs, repoPath } = cfg;
  const errors: ParseError[] = [];

  logger.info({ repoPath, command, args }, `Starting ${label} analyzer`);

  let stdout: string;
  let stderr: string;

  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });

    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const execError = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      stderr?: string;
    };

    if (execError.killed || execError.signal === "SIGTERM") {
      logger.error({ repoPath }, `${label} analyzer timed out`);
      return {
        routes: [],
        errors: [
          {
            file: repoPath,
            reason: `Analyzer timed out after ${timeoutMs / 1000}s`,
          },
        ],
      };
    }

    const stderrOutput = execError.stderr || execError.message || "Unknown error";
    logger.error({ repoPath, error: truncate(stderrOutput, MAX_LOG_OUTPUT) }, `${label} analyzer failed`);
    return {
      routes: [],
      errors: [
        {
          file: repoPath,
          reason: `Analyzer error: ${truncate(stderrOutput, MAX_LOG_OUTPUT)}`,
        },
      ],
    };
  }

  // Capture stderr warnings (non-fatal)
  if (stderr) {
    logger.warn({ repoPath, stderr: truncate(stderr, MAX_LOG_OUTPUT) }, `${label} analyzer stderr output`);
    errors.push({
      file: repoPath,
      reason: `Analyzer warning: ${truncate(stderr.trim(), MAX_LOG_OUTPUT)}`,
    });
  }

  // Parse JSON output
  let parsed: ExternalParseResult;
  try {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        routes: [],
        errors: [
          {
            file: repoPath,
            reason: "Analyzer returned empty output",
          },
        ],
      };
    }
    parsed = JSON.parse(trimmed) as ExternalParseResult;

    // Validate shape of parsed output
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.routes)) {
      logger.error(
        { repoPath, output: truncate(stdout, MAX_LOG_OUTPUT) },
        `Invalid ${label} analyzer output: missing routes array`
      );
      return {
        routes: [],
        errors: [
          {
            file: repoPath,
            reason: "Analyzer returned invalid output structure (expected { routes: [...] })",
          },
        ],
      };
    }

    if (parsed.errors && !Array.isArray(parsed.errors)) {
      parsed.errors = [];
    }
  } catch {
    logger.error(
      { repoPath, stdout: truncate(stdout, MAX_LOG_OUTPUT) },
      `Failed to parse ${label} analyzer JSON output`
    );
    return {
      routes: [],
      errors: [
        {
          file: repoPath,
          reason: `Invalid JSON output from analyzer: ${stdout.substring(0, 200)}`,
        },
      ],
    };
  }

  // Convert external output to ParseResult format
  const routes: RouteInfo[] = parsed.routes.map(
    (r: ExternalRouteInfo): RouteInfo => ({
      path: r.path,
      method: normalizeHttpMethod(r.method),
      controller: r.controller ?? null,
      routePrefix: r.routePrefix ?? null,
      params: r.params.map(
        (p): ParamInfo => ({
          name: p.name,
          in: p.in as ParamInfo["in"],
          type: p.type,
          required: p.required,
        })
      ),
      requestBody: r.requestBody
        ? {
            type: r.requestBody.type,
            contentType: r.requestBody.contentType,
            properties: r.requestBody.properties.map(
              (prop): PropertyInfo => ({
                name: prop.name,
                type: prop.type,
                required: prop.required,
              })
            ),
          }
        : null,
      responses: r.responses.map(
        (resp): ResponseInfo => ({
          status: resp.status,
          type: resp.type ?? null,
          properties: resp.properties.map(
            (prop): PropertyInfo => ({
              name: prop.name,
              type: prop.type,
              required: prop.required,
            })
          ),
        })
      ),
      auth: r.auth ?? null,
      middleware: r.middleware ?? [],
      description: r.description ?? null,
      source: r.source,
    })
  );

  // Merge errors from the analyzer
  const parseErrors: ParseError[] = [
    ...errors,
    ...(parsed.errors || []).map(
      (e): ParseError => ({
        file: e.file,
        reason: e.reason,
      })
    ),
  ];

  logger.info(
    { repoPath, routeCount: routes.length, errorCount: parseErrors.length },
    `${label} analyzer completed`
  );

  return { routes, errors: parseErrors };
}
