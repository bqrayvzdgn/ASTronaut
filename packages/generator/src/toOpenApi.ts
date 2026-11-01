import type { ParseResult } from "@astronaut/core";
import { authToSecurityScheme } from "./authToSecurityScheme.js";
import { routeToOperation } from "./routeToOperation.js";
import { schemaToJsonSchema } from "./schemaToJsonSchema.js";
import type {
  ComponentsObject,
  OpenApiDocument,
  OperationObject,
  PathItemObject,
  SchemaObject,
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

  const components = buildComponents(result, paths);
  if (components) doc.components = components;

  const tags = collectTags(result);
  if (tags.length > 0) doc.tags = tags;

  return doc;
}

function deriveTitle(result: ParseResult): string {
  const framework = result.metadata?.framework;
  return framework ? `${framework} API` : "API";
}

function buildPaths(result: ParseResult): Record<string, PathItemObject> | undefined {
  if (result.routes.length === 0) return undefined;
  const paths: Record<string, PathItemObject> = {};
  const operations: OperationEntry[] = [];
  for (const route of result.routes) {
    const verb = HTTP_METHOD_TO_OPENAPI[route.method];
    if (!verb) continue;
    const item = paths[route.path] ?? {};
    if ((item as any)[verb] !== undefined) {
      warn(
        `Duplicate route ${route.method} ${route.path}; keeping the first and skipping the duplicate.`,
      );
      continue;
    }
    const op = routeToOperation(route);
    (item as any)[verb] = op;
    paths[route.path] = item;
    operations.push({ op, path: route.path, tag: route.tags?.[0] });
  }
  assignOperationIds(operations);
  return paths;
}

interface OperationEntry {
  op: OperationObject;
  path: string;
  tag: string | undefined;
}

function assignOperationIds(entries: OperationEntry[]): void {
  const withId = entries.filter((e) => e.op.operationId);
  const ids = new Map<OperationEntry, string>(withId.map((e) => [e, e.op.operationId as string]));

  const baseCounts = countValues(ids.values());
  for (const [entry, id] of ids) {
    if ((baseCounts.get(id) ?? 0) > 1 && entry.tag) ids.set(entry, `${entry.tag}_${id}`);
  }

  const qualifiedCounts = countValues(ids.values());
  for (const [entry, id] of ids) {
    if ((qualifiedCounts.get(id) ?? 0) <= 1) continue;
    const version = versionSegment(entry.path);
    if (version) ids.set(entry, `${id}_${version}`);
  }

  const finalCounts = countValues(ids.values());
  const used = new Set<string>();
  for (const [, id] of ids) if ((finalCounts.get(id) ?? 0) === 1) used.add(id);
  for (const [entry, id] of ids) {
    if ((finalCounts.get(id) ?? 0) > 1) {
      let candidate = id;
      let n = 2;
      while (used.has(candidate)) candidate = `${id}_${n++}`;
      used.add(candidate);
      ids.set(entry, candidate);
    }
    entry.op.operationId = ids.get(entry) as string;
  }
}

function countValues(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function versionSegment(path: string): string | undefined {
  for (const segment of path.split("/")) {
    if (/^v\d+(?:\.\d+)*$/i.test(segment)) return segment.toLowerCase().replace(/\./g, "_");
  }
  return undefined;
}

function warn(message: string): void {
  (globalThis as { console?: { warn(msg: string): void } }).console?.warn(message);
}

function buildComponents(
  result: ParseResult,
  paths: Record<string, PathItemObject> | undefined,
): ComponentsObject | undefined {
  const components: ComponentsObject = {};

  if (result.sharedSchemas && Object.keys(result.sharedSchemas).length > 0) {
    const all: Record<string, SchemaObject> = {};
    for (const [name, schema] of Object.entries(result.sharedSchemas)) {
      all[name] = schemaToJsonSchema(schema);
    }
    const reachable = reachableSchemaNames(all, paths);
    if (reachable.size > 0) {
      components.schemas = {};
      for (const name of Object.keys(all)) {
        if (reachable.has(name)) components.schemas[name] = all[name] as SchemaObject;
      }
    }
  }

  const securitySchemes = collectSecuritySchemes(result);
  if (Object.keys(securitySchemes).length > 0) {
    components.securitySchemes = securitySchemes;
  }

  if (!components.schemas && !components.securitySchemes) return undefined;
  return components;
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

function reachableSchemaNames(
  schemas: Record<string, SchemaObject>,
  paths: Record<string, PathItemObject> | undefined,
): Set<string> {
  const reachable = new Set<string>();
  const queue: unknown[] = [paths];
  while (queue.length > 0) {
    collectRefs(queue.pop(), (ref) => {
      if (!ref.startsWith(SCHEMA_REF_PREFIX)) return;
      const name = ref.slice(SCHEMA_REF_PREFIX.length);
      if (reachable.has(name) || !(name in schemas)) return;
      reachable.add(name);
      queue.push(schemas[name]);
    });
  }
  return reachable;
}

function collectRefs(node: unknown, onRef: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, onRef);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") onRef(value);
      else collectRefs(value, onRef);
    }
  }
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
