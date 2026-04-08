export interface ParseResult {
  routes: RouteInfo[];
  errors: ParseError[];
}

export interface RouteInfo {
  path: string;
  method: HttpMethod;
  controller: string | null;
  routePrefix: string | null;
  params: ParamInfo[];
  requestBody: RequestBodyInfo | null;
  responses: ResponseInfo[];
  auth: string | null;
  middleware: string[];
  description: string | null;
  source: string;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

export interface ParamInfo {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  type: string;
  required: boolean;
}

export interface RequestBodyInfo {
  type: string;
  contentType?: string;
  properties: PropertyInfo[];
}

export interface ResponseInfo {
  status: number;
  type: string | null;
  properties: PropertyInfo[];
}

export interface PropertyInfo {
  name: string;
  type: string;
  required: boolean;
}

export interface ParseError {
  file: string;
  reason: string;
}

export interface FrameworkModule {
  /** Unique identifier, e.g. "express", "aspnet", "gin" */
  readonly id: string;
  /** Human-readable name, e.g. "Express.js", "ASP.NET Core", "Gin" */
  readonly name: string;
  /** Languages this module handles, e.g. ["javascript", "typescript"] */
  readonly languages: readonly string[];
  /**
   * Check whether this module can parse the given repo.
   * Returns a confidence score: 0 = cannot handle, 1+ = can handle.
   * Higher values win when multiple modules match.
   */
  detect(repoPath: string): Promise<number>;
  /** Parse the repo and return routes. */
  parse(repoPath: string): Promise<ParseResult>;
}
