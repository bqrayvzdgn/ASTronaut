import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config";
import { logger } from "../utils/logger";
import { ParseResult, RouteInfo, ParamInfo, RequestBodyInfo, ResponseInfo, PropertyInfo, ParseError } from "./types";

const execFileAsync = promisify(execFile);

const DOTNET_TIMEOUT_MS = config.timeouts?.parseMs ?? 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

interface DotnetRouteInfo {
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

interface DotnetParseResult {
  routes: DotnetRouteInfo[];
  errors: Array<{
    file: string;
    reason: string;
  }>;
}

export async function parseDotnet(repoPath: string): Promise<ParseResult> {
  const analyzerDllPath = config.dotnetAnalyzerPath;
  const errors: ParseError[] = [];

  logger.info({ repoPath, analyzerDllPath }, "Starting .NET analyzer");

  let stdout: string;
  let stderr: string;

  try {
    const result = await execFileAsync("dotnet", [analyzerDllPath, repoPath], {
      timeout: DOTNET_TIMEOUT_MS,
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
      logger.error({ repoPath }, ".NET analyzer timed out");
      return {
        routes: [],
        errors: [
          {
            file: repoPath,
            reason: `Analyzer timed out after ${DOTNET_TIMEOUT_MS / 1000}s`,
          },
        ],
      };
    }

    const stderrOutput = execError.stderr || execError.message || "Unknown error";
    logger.error({ repoPath, error: stderrOutput }, ".NET analyzer failed");
    return {
      routes: [],
      errors: [
        {
          file: repoPath,
          reason: `Analyzer error: ${stderrOutput}`,
        },
      ],
    };
  }

  // Capture stderr warnings (non-fatal)
  if (stderr) {
    logger.warn({ repoPath, stderr }, ".NET analyzer stderr output");
    errors.push({
      file: repoPath,
      reason: `Analyzer warning: ${stderr.trim()}`,
    });
  }

  // Parse JSON output
  let parsed: DotnetParseResult;
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
    parsed = JSON.parse(trimmed) as DotnetParseResult;
  } catch {
    logger.error(
      { repoPath, stdout: stdout.substring(0, 500) },
      "Failed to parse analyzer JSON output"
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

  // Convert dotnet output to ParseResult format
  const routes: RouteInfo[] = parsed.routes.map(
    (r: DotnetRouteInfo): RouteInfo => ({
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
    ".NET analyzer completed"
  );

  return { routes, errors: parseErrors };
}

function normalizeHttpMethod(method: string): RouteInfo["method"] {
  const upper = method.toUpperCase();
  const valid = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
  type ValidMethod = (typeof valid)[number];
  if (valid.includes(upper as ValidMethod)) {
    return upper as RouteInfo["method"];
  }
  return "GET";
}
