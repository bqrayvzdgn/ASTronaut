import type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
} from "./types.js";

// Semantic invariants the OpenAPI 3.1 meta-schema does not enforce but every
// consumer relies on. Mirrors docs/test-scenarios.md §T; the meta-schema check
// itself (T1) stays with the validator in the e2e suite. Pure and dependency-
// free so the e2e suite, the live-project harness and a future CLI `--check`
// can all share it.
export type InvariantRule =
  | "unique-operation-ids"
  | "unique-parameters"
  | "resolvable-refs"
  | "path-params-match-template"
  | "security-schemes-defined"
  | "nullable-3-1-style"
  | "no-empty-schema";

export interface InvariantViolation {
  rule: InvariantRule;
  /** Human-readable location, e.g. `paths./users/{id}.get.parameters[1]`. */
  path: string;
  message: string;
}

const VERBS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SCHEMA_REF_PREFIX = "#/components/schemas/";

export function checkOpenApiInvariants(doc: OpenApiDocument): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
  const schemeNames = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
  const operationIds = new Map<string, string>();

  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    checkSchema(schema, `components.schemas.${name}`, schemaNames, out);
  }
  for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
    checkSecurityScheme(scheme, `components.securitySchemes.${name}`, out);
  }
  checkSecurityRequirements(doc.security, "security", schemeNames, out);

  for (const [route, item] of Object.entries(doc.paths ?? {})) {
    const placeholders = templatePlaceholders(route);
    for (const verb of VERBS) {
      const op = item[verb];
      if (!op) continue;
      const at = `paths.${route}.${verb}`;
      checkOperationId(op, at, operationIds, out);

      // Path-item level parameters apply to every operation beneath them.
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])];
      checkUniqueParameters(params, at, out);
      checkPathParams(params, placeholders, at, out);
      for (const [i, p] of params.entries()) {
        checkSchema(p.schema, `${at}.parameters[${i}].schema`, schemaNames, out);
      }

      for (const [ct, media] of Object.entries(op.requestBody?.content ?? {})) {
        checkSchema(media.schema, `${at}.requestBody.content.${ct}.schema`, schemaNames, out);
      }
      for (const [status, response] of Object.entries(op.responses)) {
        for (const [ct, media] of Object.entries(response.content ?? {})) {
          const where = `${at}.responses.${status}.content.${ct}.schema`;
          checkSchema(media.schema, where, schemaNames, out);
        }
        for (const [name, header] of Object.entries(response.headers ?? {})) {
          const where = `${at}.responses.${status}.headers.${name}.schema`;
          checkSchema(header.schema, where, schemaNames, out);
        }
      }
      checkSecurityRequirements(op.security, `${at}.security`, schemeNames, out);
    }
  }
  return out;
}

function checkOperationId(
  op: OperationObject,
  at: string,
  seen: Map<string, string>,
  out: InvariantViolation[],
): void {
  if (!op.operationId) return;
  const first = seen.get(op.operationId);
  if (first !== undefined) {
    out.push({
      rule: "unique-operation-ids",
      path: `${at}.operationId`,
      message: `operationId "${op.operationId}" is also used by ${first}`,
    });
    return;
  }
  seen.set(op.operationId, at);
}

function checkUniqueParameters(
  params: ParameterObject[],
  at: string,
  out: InvariantViolation[],
): void {
  const seen = new Set<string>();
  for (const [i, p] of params.entries()) {
    const key = `${p.in}:${p.name}`;
    if (seen.has(key)) {
      out.push({
        rule: "unique-parameters",
        path: `${at}.parameters[${i}]`,
        message: `duplicate parameter ${key}`,
      });
    }
    seen.add(key);
  }
}

// "/users/{id}/posts/{postId}" → ["id", "postId"]
function templatePlaceholders(route: string): string[] {
  const names: string[] = [];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

// Every template placeholder needs an in:path parameter and vice versa, and
// path parameters are always required (the spec forbids optional ones).
function checkPathParams(
  params: ParameterObject[],
  placeholders: string[],
  at: string,
  out: InvariantViolation[],
): void {
  const declared = new Set(params.filter((p) => p.in === "path").map((p) => p.name));
  for (const name of placeholders) {
    if (!declared.has(name)) {
      out.push({
        rule: "path-params-match-template",
        path: `${at}.parameters`,
        message: `template placeholder {${name}} has no in:path parameter`,
      });
    }
  }
  const expected = new Set(placeholders);
  for (const [i, p] of params.entries()) {
    if (p.in !== "path") continue;
    if (!expected.has(p.name)) {
      out.push({
        rule: "path-params-match-template",
        path: `${at}.parameters[${i}]`,
        message: `in:path parameter "${p.name}" does not appear in the route template`,
      });
    }
    if (p.required !== true) {
      out.push({
        rule: "path-params-match-template",
        path: `${at}.parameters[${i}]`,
        message: `in:path parameter "${p.name}" must be required`,
      });
    }
  }
}

function checkSecurityRequirements(
  requirements: SecurityRequirementObject[] | undefined,
  at: string,
  schemes: Set<string>,
  out: InvariantViolation[],
): void {
  if (!requirements) return;
  for (const [i, requirement] of requirements.entries()) {
    for (const name of Object.keys(requirement)) {
      if (!schemes.has(name)) {
        out.push({
          rule: "security-schemes-defined",
          path: `${at}[${i}]`,
          message: `security scheme "${name}" is not defined in components.securitySchemes`,
        });
      }
    }
  }
}

// 3.1 marks these sub-fields REQUIRED; without them the scheme is not usable.
function checkSecurityScheme(
  scheme: SecuritySchemeObject,
  at: string,
  out: InvariantViolation[],
): void {
  if (scheme.type === "oauth2" && scheme.flows === undefined) {
    out.push({
      rule: "security-schemes-defined",
      path: at,
      message: "oauth2 scheme must carry a flows object",
    });
  }
  if (scheme.type === "openIdConnect" && typeof scheme.openIdConnectUrl !== "string") {
    out.push({
      rule: "security-schemes-defined",
      path: at,
      message: "openIdConnect scheme must carry openIdConnectUrl",
    });
  }
}

// Walks a schema through the positions the generator emits (properties, items,
// oneOf/anyOf/allOf, object-form additionalProperties). `example` and `default`
// hold data, not schemas, and are skipped on purpose.
function checkSchema(
  schema: SchemaObject | null | undefined,
  at: string,
  names: Set<string>,
  out: InvariantViolation[],
): void {
  if (schema === null || schema === undefined) {
    out.push({ rule: "no-empty-schema", path: at, message: "schema is missing" });
    return;
  }
  if (Object.keys(schema).length === 0) {
    out.push({ rule: "no-empty-schema", path: at, message: "schema is an empty object" });
    return;
  }
  if ("nullable" in schema) {
    out.push({
      rule: "nullable-3-1-style",
      path: at,
      message: '3.0-style `nullable` keyword; 3.1 expresses null via type: [..., "null"]',
    });
  }
  if (schema.$ref !== undefined) {
    checkRef(schema.$ref, `${at}.$ref`, names, out);
  }
  for (const [value, ref] of Object.entries(schema.discriminator?.mapping ?? {})) {
    checkRef(ref, `${at}.discriminator.mapping.${value}`, names, out);
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    checkSchema(property, `${at}.properties.${key}`, names, out);
  }
  if (schema.items !== undefined) checkSchema(schema.items, `${at}.items`, names, out);
  for (const kind of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[kind];
    if (!variants) continue;
    for (const [i, variant] of variants.entries()) {
      checkSchema(variant, `${at}.${kind}[${i}]`, names, out);
    }
  }
  if (typeof schema.additionalProperties === "object") {
    checkSchema(schema.additionalProperties, `${at}.additionalProperties`, names, out);
  }
}

// Only local refs into components.schemas are ever emitted; anything else is
// unresolvable by construction.
function checkRef(ref: string, at: string, names: Set<string>, out: InvariantViolation[]): void {
  const target = ref.startsWith(SCHEMA_REF_PREFIX) ? ref.slice(SCHEMA_REF_PREFIX.length) : null;
  if (target === null || !names.has(target)) {
    out.push({ rule: "resolvable-refs", path: at, message: `unresolvable $ref "${ref}"` });
  }
}
