import type { ParseResult } from "@astronaut/core";
import { authToSecurityScheme } from "./authToSecurityScheme.js";
import { routeToOperation } from "./routeToOperation.js";
import { schemaToJsonSchema } from "./schemaToJsonSchema.js";
import type {
  ComponentsObject,
  OpenApiDocument,
  PathItemObject,
  SecuritySchemeObject,
  TagObject,
} from "./types.js";

export interface ToOpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
}

const HTTP_METHOD_TO_OPENAPI: Record<string, keyof PathItemObject> = {
  GET: "get",
  PUT: "put",
  POST: "post",
  DELETE: "delete",
  OPTIONS: "options",
  HEAD: "head",
  PATCH: "patch",
  TRACE: "trace",
};

export function toOpenApi(result: ParseResult, options: ToOpenApiOptions = {}): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? deriveTitle(result),
      version: options.version ?? "0.0.0",
    },
  };
  if (options.description) doc.info.description = options.description;

  const paths = buildPaths(result);
  if (paths) doc.paths = paths;

  const components = buildComponents(result);
  if (components) doc.components = components;

  const tags = collectTags(result);
  if (tags.length > 0) doc.tags = tags;

  return doc;
}

function deriveTitle(result: ParseResult): string {
  return result.metadata.framework ? `${result.metadata.framework} API` : "API";
}

function buildPaths(result: ParseResult): Record<string, PathItemObject> | undefined {
  if (result.routes.length === 0) return undefined;
  const paths: Record<string, PathItemObject> = {};
  const usedOperationIds = new Set<string>();
  for (const route of result.routes) {
    const verb = HTTP_METHOD_TO_OPENAPI[route.method];
    if (!verb) continue;
    const item = paths[route.path] ?? {};
    // Two routes sharing the same path + method would silently overwrite each
    // other. Keep the first occurrence and skip later duplicates with a warning.
    // biome-ignore lint/suspicious/noExplicitAny: PathItemObject's verb keys all hold OperationObject
    if ((item as any)[verb] !== undefined) {
      warn(
        `Duplicate route ${route.method} ${route.path}; keeping the first and skipping the duplicate.`,
      );
      continue;
    }
    const op = routeToOperation(route);
    if (op.operationId)
      op.operationId = uniqueOperationId(op.operationId, route.tags, usedOperationIds);
    // biome-ignore lint/suspicious/noExplicitAny: PathItemObject's verb keys all hold OperationObject
    (item as any)[verb] = op;
    paths[route.path] = item;
  }
  return paths;
}

// operationId must be unique across the whole document (many controllers share
// action names like "Get"). Keep the first as-is; qualify a collision with its
// tag (e.g. "Rating_Get"), then fall back to a numeric suffix.
function uniqueOperationId(base: string, tags: string[] | undefined, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const tag = tags?.[0];
  if (tag) {
    const qualified = `${tag}_${base}`;
    if (!used.has(qualified)) {
      used.add(qualified);
      return qualified;
    }
  }
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  const result = `${base}_${n}`;
  used.add(result);
  return result;
}

// The generator package has no Node type deps, so reach `console` defensively
// through globalThis. Warnings go to stderr where the CLI already surfaces them.
function warn(message: string): void {
  (globalThis as { console?: { warn(msg: string): void } }).console?.warn(message);
}

function buildComponents(result: ParseResult): ComponentsObject | undefined {
  const components: ComponentsObject = {};

  if (result.sharedSchemas && Object.keys(result.sharedSchemas).length > 0) {
    components.schemas = {};
    for (const [name, schema] of Object.entries(result.sharedSchemas)) {
      components.schemas[name] = schemaToJsonSchema(schema);
    }
  }

  const securitySchemes = collectSecuritySchemes(result);
  if (Object.keys(securitySchemes).length > 0) {
    components.securitySchemes = securitySchemes;
  }

  if (!components.schemas && !components.securitySchemes) return undefined;
  return components;
}

function collectSecuritySchemes(result: ParseResult): Record<string, SecuritySchemeObject> {
  const out: Record<string, SecuritySchemeObject> = {};
  for (const route of result.routes) {
    if (!route.auth) continue;
    if (out[route.auth.id]) continue;
    out[route.auth.id] = authToSecurityScheme(route.auth);
  }
  return out;
}

function collectTags(result: ParseResult): TagObject[] {
  const seen = new Set<string>();
  const tags: TagObject[] = [];
  for (const route of result.routes) {
    for (const tag of route.tags ?? []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push({ name: tag });
    }
  }
  return tags;
}
