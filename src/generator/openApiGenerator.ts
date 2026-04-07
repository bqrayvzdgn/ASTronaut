import * as yaml from "js-yaml";
import {
  ParseResult,
  RouteInfo,
  ParamInfo,
  RequestBodyInfo,
  ResponseInfo,
  PropertyInfo,
} from "../parser/types";

export interface GeneratorOptions {
  title: string;
  version: string;
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

const TYPE_MAP: Record<string, string> = {
  int: "integer",
  integer: "integer",
  long: "integer",
  string: "string",
  boolean: "boolean",
  bool: "boolean",
  float: "number",
  double: "number",
  decimal: "number",
  number: "number",
  array: "array",
  object: "object",
  any: "object",
};

function mapType(type: string): string {
  return TYPE_MAP[type.toLowerCase()] ?? "string";
}

function extractArrayItemType(type: string): string {
  // Handle "string[]", "number[]", "User[]"
  const bracketMatch = type.match(/^(.+)\[\]$/);
  if (bracketMatch) return bracketMatch[1];

  // Handle "Array<string>", "Array<User>"
  const genericMatch = type.match(/^Array<(.+)>$/i);
  if (genericMatch) return genericMatch[1];

  return "string";
}

/**
 * Strip ASP.NET route constraints from path: {id:guid} → {id}
 */
function stripRouteConstraints(path: string): string {
  return path.replace(/\{(\w+):[^}]+\}/g, "{$1}");
}

function buildOperationId(
  controller: string | null,
  method: string,
  path: string
): string {
  const controllerPart = controller
    ? controller.replace(/Controller$/i, "")
    : "default";

  const cleanPath = stripRouteConstraints(path);
  const pathPart = cleanPath
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      if (seg.startsWith("{") && seg.endsWith("}")) {
        const paramName = seg.slice(1, -1);
        return "By" + paramName.charAt(0).toUpperCase() + paramName.slice(1);
      }
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    })
    .join("");

  return `${method.toLowerCase()}${controllerPart}${pathPart}`;
}

function schemaName(controller: string | null, typeName: string): string {
  const prefix = controller ?? "Default";
  return `${prefix}.${typeName}`;
}

function buildSchemaRef(controller: string | null, typeName: string): string {
  return `#/components/schemas/${schemaName(controller, typeName)}`;
}

function buildPropertiesSchema(
  properties: PropertyInfo[]
): { properties: Record<string, unknown>; required?: string[] } {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const prop of properties) {
    const mappedType = mapType(prop.type);
    if (mappedType === "array") {
      const itemType = extractArrayItemType(prop.type);
      props[prop.name] = { type: "array", items: { type: mapType(itemType) } };
    } else {
      props[prop.name] = { type: mappedType };
    }
    if (prop.required) {
      required.push(prop.name);
    }
  }

  const result: { properties: Record<string, unknown>; required?: string[] } = {
    properties: props,
  };
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function buildParameters(params: ParamInfo[]): Record<string, unknown>[] {
  return params.map((param) => ({
    name: param.name,
    in: param.in,
    required: param.required,
    schema: { type: mapType(param.type) },
  }));
}

function addRequestBodySchema(
  spec: OpenApiSpec,
  route: RouteInfo
): Record<string, unknown> | undefined {
  if (!route.requestBody) {
    return undefined;
  }

  const rb = route.requestBody;
  const contentType = rb.contentType || "application/json";

  // multipart/form-data (file upload)
  if (contentType === "multipart/form-data") {
    const formProps: Record<string, unknown> = {};
    for (const prop of rb.properties) {
      formProps[prop.name] =
        prop.type === "binary"
          ? { type: "string", format: "binary" }
          : { type: mapType(prop.type) };
    }

    return {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: formProps,
          },
        },
      },
    };
  }

  const name = schemaName(route.controller, rb.type);

  if (!spec.components.schemas[name]) {
    const schemaObj: Record<string, unknown> = {
      type: "object",
      ...buildPropertiesSchema(rb.properties),
    };
    spec.components.schemas[name] = schemaObj;
  }

  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: buildSchemaRef(route.controller, rb.type) },
      },
    },
  };
}

function buildResponses(
  spec: OpenApiSpec,
  route: RouteInfo
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};

  if (route.responses.length === 0) {
    responses["200"] = { description: "Success" };
    return responses;
  }

  for (const resp of route.responses) {
    const statusKey = String(resp.status);

    if (resp.type && resp.properties.length > 0) {
      const name = schemaName(route.controller, resp.type);

      if (!spec.components.schemas[name]) {
        const schemaObj: Record<string, unknown> = {
          type: "object",
          ...buildPropertiesSchema(resp.properties),
        };
        spec.components.schemas[name] = schemaObj;
      }

      responses[statusKey] = {
        description: descriptionForStatus(resp.status),
        content: {
          "application/json": {
            schema: { $ref: buildSchemaRef(route.controller, resp.type) },
          },
        },
      };
    } else if (resp.type) {
      responses[statusKey] = {
        description: descriptionForStatus(resp.status),
        content: {
          "application/json": {
            schema: { type: mapType(resp.type) },
          },
        },
      };
    } else {
      responses[statusKey] = {
        description: descriptionForStatus(resp.status),
      };
    }
  }

  return responses;
}

function descriptionForStatus(status: number): string {
  const descriptions: Record<number, string> = {
    200: "Success",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    500: "Internal Server Error",
  };
  return descriptions[status] ?? `Response ${status}`;
}

function addSecuritySchemes(spec: OpenApiSpec, routes: RouteInfo[]): void {
  const authTypes = new Set<string>();
  for (const route of routes) {
    if (route.auth) {
      authTypes.add(route.auth);
    }
  }

  authTypes.forEach((authType) => {
    const lower = authType.toLowerCase();
    if (lower === "bearer" || lower === "jwt") {
      spec.components.securitySchemes["Bearer"] = {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      };
    } else if (lower === "apikey" || lower === "api-key" || lower === "api_key") {
      spec.components.securitySchemes["ApiKey"] = {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      };
    } else {
      spec.components.securitySchemes[authType] = {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      };
    }
  });
}

function buildSecurity(
  route: RouteInfo
): Record<string, unknown[]>[] | undefined {
  if (!route.auth) {
    return undefined;
  }

  const lower = route.auth.toLowerCase();
  if (lower === "apikey" || lower === "api-key" || lower === "api_key") {
    return [{ ApiKey: [] }];
  }
  if (lower === "bearer" || lower === "jwt") {
    return [{ Bearer: [] }];
  }
  return [{ [route.auth]: [] }];
}

export function generateOpenApiSpec(
  parseResult: ParseResult,
  options: GeneratorOptions
): string {
  const spec: OpenApiSpec = {
    openapi: "3.0.3",
    info: {
      title: options.title,
      version: options.version,
    },
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {},
    },
  };

  const usedOperationIds = new Set<string>();

  for (const route of parseResult.routes) {
    const pathKey = stripRouteConstraints(route.path);
    const methodKey = route.method.toLowerCase();

    if (!spec.paths[pathKey]) {
      spec.paths[pathKey] = {};
    }

    const operation: Record<string, unknown> = {};

    let operationId = buildOperationId(
      route.controller,
      route.method,
      route.path
    );
    if (usedOperationIds.has(operationId)) {
      let counter = 2;
      while (usedOperationIds.has(`${operationId}_${counter}`)) counter++;
      operationId = `${operationId}_${counter}`;
    }
    usedOperationIds.add(operationId);
    operation.operationId = operationId;

    operation.tags = [route.controller ?? "default"];

    if (route.description) {
      operation.description = route.description;
    }

    if (route.params.length > 0) {
      operation.parameters = buildParameters(route.params);
    }

    const requestBody = addRequestBodySchema(spec, route);
    if (requestBody) {
      operation.requestBody = requestBody;
    }

    operation.responses = buildResponses(spec, route);

    const security = buildSecurity(route);
    if (security) {
      operation.security = security;
    }

    (spec.paths[pathKey] as Record<string, unknown>)[methodKey] = operation;
  }

  addSecuritySchemes(spec, parseResult.routes);

  // Remove empty securitySchemes to keep output clean
  if (Object.keys(spec.components.securitySchemes).length === 0) {
    delete (spec.components as Record<string, unknown>).securitySchemes;
  }

  // Remove empty schemas to keep output clean
  if (Object.keys(spec.components.schemas).length === 0) {
    delete (spec.components as Record<string, unknown>).schemas;
  }

  // Remove empty components if both were removed
  if (Object.keys(spec.components).length === 0) {
    delete (spec as unknown as Record<string, unknown>).components;
  }

  return yaml.dump(spec, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}
