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
