import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  type AuthInfo,
  type BodyInfo,
  type Constraints,
  type ParamInfo,
  type ParseResult,
  ParseResultSchema,
  type ResponseInfo,
  type RouteInfo,
  type Schema,
} from "./generated/parser_pb.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const PRIMITIVE_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);
const PARAM_LOCATIONS = new Set(["header", "query", "cookie"]);
const AUTH_TYPES = new Set(["http", "apiKey", "mutualTLS", "oauth2", "openIdConnect"]);
const SEVERITIES = new Set(["warning", "error"]);

export interface IRIssue {
  path: string;
  message: string;
}

export class IRValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: IRIssue[],
  ) {
    super(message);
    this.name = "IRValidationError";
  }
}

export function parseIR(value: unknown): ParseResult {
  let result: ParseResult;
  try {
    result = fromJson(ParseResultSchema, value as JsonValue);
  } catch (err) {
    throw toError([{ path: "<root>", message: (err as Error).message }]);
  }
  const issues = checkIR(result);
  if (issues.length > 0) throw toError(issues);
  return result;
}

export function checkIR(result: ParseResult): IRIssue[] {
  const issues: IRIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });

  result.routes.forEach((route, i) => checkRoute(route, `routes.${i}`, fail));
  result.errors.forEach((error, i) => {
    const at = `errors.${i}`;
    nonNegative(error.line, `${at}.line`, fail);
    if (error.message.length === 0) fail(`${at}.message`, "must not be empty");
    oneOf(error.severity, SEVERITIES, `${at}.severity`, fail);
  });

  const metadata = result.metadata;
  if (!metadata) {
    fail("metadata", "is required");
  } else {
    if (metadata.framework.length === 0) fail("metadata.framework", "must not be empty");
    nonNegative(metadata.filesScanned, "metadata.filesScanned", fail);
    if (metadata.durationMs < 0n) fail("metadata.durationMs", "must be >= 0");
    if (metadata.parserVersion.length === 0) fail("metadata.parserVersion", "must not be empty");
  }

  for (const [name, schema] of Object.entries(result.sharedSchemas)) {
    checkSchema(schema, `sharedSchemas.${name}`, fail);
  }
  return issues;
}

type Fail = (path: string, message: string) => void;

function checkRoute(route: RouteInfo, at: string, fail: Fail): void {
  oneOf(route.method, HTTP_METHODS, `${at}.method`, fail);
  if (!route.path.startsWith("/")) fail(`${at}.path`, 'must start with "/"');
  route.pathParams.forEach((p, i) => checkParam(p, `${at}.pathParams.${i}`, fail));
  route.queryParams.forEach((p, i) => checkParam(p, `${at}.queryParams.${i}`, fail));
  route.headerParams.forEach((p, i) => checkParam(p, `${at}.headerParams.${i}`, fail));
  if (route.requestBody) checkBody(route.requestBody, `${at}.requestBody`, fail);
  route.responses.forEach((r, i) => checkResponse(r, `${at}.responses.${i}`, fail));
  if (route.auth) checkAuth(route.auth, `${at}.auth`, fail);
  if (!route.source) {
    fail(`${at}.source`, "is required");
  } else {
    nonNegative(route.source.line, `${at}.source.line`, fail);
    nonNegative(route.source.column, `${at}.source.column`, fail);
  }
}

function checkParam(param: ParamInfo, at: string, fail: Fail): void {
  if (param.name.length === 0) fail(`${at}.name`, "must not be empty");
  if (!param.schema) fail(`${at}.schema`, "is required");
  else checkSchema(param.schema, `${at}.schema`, fail);
}

function checkBody(body: BodyInfo, at: string, fail: Fail): void {
  if (body.contentType.length === 0) fail(`${at}.contentType`, "must not be empty");
  if (!body.schema) fail(`${at}.schema`, "is required");
  else checkSchema(body.schema, `${at}.schema`, fail);
  contentTypes(body.contentTypes, `${at}.contentTypes`, fail);
}

function checkResponse(response: ResponseInfo, at: string, fail: Fail): void {
  if (response.status < 100 || response.status > 599) fail(`${at}.status`, "must be 100-599");
  if (response.schema) checkSchema(response.schema, `${at}.schema`, fail);
  for (const [name, header] of Object.entries(response.headers)) {
    checkParam(header, `${at}.headers.${name}`, fail);
  }
  contentTypes(response.contentTypes, `${at}.contentTypes`, fail);
}

function checkAuth(auth: AuthInfo, at: string, fail: Fail): void {
  oneOf(auth.type, AUTH_TYPES, `${at}.type`, fail);
  if (auth.in !== undefined) oneOf(auth.in, PARAM_LOCATIONS, `${at}.in`, fail);
  if (auth.id.length === 0) fail(`${at}.id`, "must not be empty");
}

function checkSchema(schema: Schema, at: string, fail: Fail): void {
  if (schema.primitiveType !== undefined) {
    oneOf(schema.primitiveType, PRIMITIVE_TYPES, `${at}.primitiveType`, fail);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    checkSchema(property, `${at}.properties.${name}`, fail);
  }
  if (schema.items) checkSchema(schema.items, `${at}.items`, fail);
  schema.variants.forEach((v, i) => checkSchema(v, `${at}.variants.${i}`, fail));
  if (schema.constraints) checkConstraints(schema.constraints, `${at}.constraints`, fail);
  if (schema.additionalProperties) {
    checkSchema(schema.additionalProperties, `${at}.additionalProperties`, fail);
  }
}

function checkConstraints(c: Constraints, at: string, fail: Fail): void {
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const value = c[key];
    if (value !== undefined) nonNegative(value, `${at}.${key}`, fail);
  }
  if (c.multipleOf !== undefined && !(c.multipleOf > 0)) fail(`${at}.multipleOf`, "must be > 0");
}

function contentTypes(values: string[], at: string, fail: Fail): void {
  values.forEach((v, i) => {
    if (v.length === 0) fail(`${at}.${i}`, "must not be empty");
  });
}

function oneOf(value: string, allowed: Set<string>, at: string, fail: Fail): void {
  if (!allowed.has(value)) fail(at, `must be one of ${[...allowed].join(", ")}`);
}

function nonNegative(value: number, at: string, fail: Fail): void {
  if (value < 0) fail(at, "must be >= 0");
}

function toError(issues: IRIssue[]): IRValidationError {
  const first = issues[0];
  return new IRValidationError(
    `Invalid ParseResult at \`${first?.path ?? "<root>"}\`: ${first?.message ?? "unknown"}`,
    issues,
  );
}
