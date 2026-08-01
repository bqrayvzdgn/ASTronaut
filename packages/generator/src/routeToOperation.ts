import type { BodyInfo, ParamInfo, ResponseInfo, RouteInfo } from "@astronaut/core";
import { schemaToJsonSchema } from "./schemaToJsonSchema.js";
import type {
  HeaderObject,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
} from "./types.js";

export function routeToOperation(route: RouteInfo): OperationObject {
  const op: OperationObject = {
    responses: buildResponses(route.responses),
  };
  if (route.tags && route.tags.length > 0) op.tags = [...route.tags];
  if (route.summary) op.summary = route.summary;
  if (route.description) op.description = route.description;
  if (route.operationId) op.operationId = route.operationId;
  if (route.deprecated) op.deprecated = true;

  const params = collectParameters(route);
  if (params.length > 0) op.parameters = params;

  if (route.requestBody) op.requestBody = toRequestBody(route.requestBody);

  if (route.auth) op.security = [{ [route.auth.id]: [] }];

  return op;
}

function collectParameters(route: RouteInfo): ParameterObject[] {
  const out: ParameterObject[] = [];
  for (const p of route.pathParams ?? []) out.push(toParameter(p, "path", true));
  for (const p of route.queryParams ?? []) out.push(toParameter(p, "query"));
  for (const p of route.headerParams ?? []) out.push(toParameter(p, "header"));
  return out;
}

function toParameter(
  param: ParamInfo,
  location: ParameterObject["in"],
  forceRequired = false,
): ParameterObject {
  const out: ParameterObject = {
    name: param.name,
    in: location,
    schema: schemaToJsonSchema(param.schema),
  };
  const required = forceRequired || param.required;
  if (required) out.required = true;
  if (param.description) out.description = param.description;
  if (param.example !== undefined) out.example = parseJsonLiteral(param.example);
  return out;
}

function toRequestBody(body: BodyInfo): RequestBodyObject {
  const jsonSchema = schemaToJsonSchema(body.schema);
  const types =
    body.contentTypes && body.contentTypes.length > 0 ? body.contentTypes : [body.contentType];
  const content: RequestBodyObject["content"] = {};
  for (const ct of types) content[ct] = { schema: jsonSchema };
  const out: RequestBodyObject = { content };
  if (body.required) out.required = true;
  return out;
}

function buildResponses(responses: ResponseInfo[] | undefined): Record<string, ResponseObject> {
  if (!responses || responses.length === 0) {
    return { default: { description: "" } };
  }
  const out: Record<string, ResponseObject> = {};
  for (const r of responses) {
    out[String(r.status)] = toResponseObject(r);
  }
  return out;
}

function toResponseObject(response: ResponseInfo): ResponseObject {
  const out: ResponseObject = { description: response.description };
  if (response.schema) {
    const jsonSchema = schemaToJsonSchema(response.schema);
    const types =
      response.contentTypes && response.contentTypes.length > 0
        ? response.contentTypes
        : [response.contentType ?? "application/json"];
    out.content = {};
    for (const ct of types) out.content[ct] = { schema: jsonSchema };
  }
  if (response.headers && Object.keys(response.headers).length > 0) {
    out.headers = {};
    for (const [name, header] of Object.entries(response.headers)) {
      out.headers[name] = toHeaderObject(header);
    }
  }
  return out;
}

function toHeaderObject(param: ParamInfo): HeaderObject {
  const out: HeaderObject = { schema: schemaToJsonSchema(param.schema) };
  if (param.required) out.required = true;
  if (param.description) out.description = param.description;
  if (param.example !== undefined) out.example = parseJsonLiteral(param.example);
  return out;
}

function parseJsonLiteral(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
