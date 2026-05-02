// ASTronaut IR — TypeScript surface aligned with proto/parser.proto.
//
// These types follow the proto3 canonical JSON mapping so subprocess parsers
// (Go, .NET) can emit JSON that round-trips through here. The .proto file is
// the source of truth; if you change one, change both.

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

export type SchemaKind =
  | "PRIMITIVE"
  | "OBJECT"
  | "ARRAY"
  | "REFERENCE"
  | "ONE_OF"
  | "ANY_OF"
  | "ALL_OF";

export type PrimitiveType = "string" | "integer" | "number" | "boolean" | "null";

export type ParamLocation = "header" | "query" | "cookie";

export type AuthType = "http" | "apiKey" | "oauth2" | "openIdConnect";

export type Severity = "warning" | "error";

export interface Constraints {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  enumValues?: string[];
  multipleOf?: number;
}

export interface Schema {
  kind: SchemaKind;
  refName?: string;
  primitiveType?: PrimitiveType;
  format?: string;
  properties?: Record<string, Schema>;
  requiredProperties?: string[];
  items?: Schema;
  variants?: Schema[];
  constraints?: Constraints;
  nullable?: boolean;
  description?: string;
  defaultValue?: string;
  example?: string;
}

export interface ParamInfo {
  name: string;
  schema: Schema;
  required: boolean;
  description?: string;
  example?: string;
}

export interface BodyInfo {
  contentType: string;
  schema: Schema;
  required: boolean;
}

export interface ResponseInfo {
  status: number;
  description: string;
  schema?: Schema;
  contentType?: string;
  headers?: Record<string, ParamInfo>;
}

export interface AuthInfo {
  type: AuthType;
  scheme?: string;
  name?: string;
  in?: ParamLocation;
  bearerFormat?: string;
  id: string;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface RouteInfo {
  method: HttpMethod;
  path: string;
  pathParams?: ParamInfo[];
  queryParams?: ParamInfo[];
  headerParams?: ParamInfo[];
  requestBody?: BodyInfo;
  responses?: ResponseInfo[];
  auth?: AuthInfo;
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  source: SourceLocation;
}

export interface ParseError {
  file: string;
  line: number;
  message: string;
  severity: Severity;
  code?: string;
}

export interface ParserMetadata {
  framework: string;
  frameworkVersion?: string;
  filesScanned: number;
  durationMs: number;
  parserVersion: string;
}

export interface ParseResult {
  routes: RouteInfo[];
  errors: ParseError[];
  metadata: ParserMetadata;
  sharedSchemas?: Record<string, Schema>;
}
