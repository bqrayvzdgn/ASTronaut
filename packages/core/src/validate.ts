// Runtime validators (zod) for IR. Used to fence subprocess parser output
// before it reaches the generator — bad JSON dies here with a useful error
// instead of producing an invalid OpenAPI spec downstream.
//
// The zod schemas mirror ir.ts. If you change ir.ts or parser.proto, change
// these too — the cross-check is enforced by tests in packages/core/test.

import { z } from "zod";

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

export const primitiveTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]);

export const schemaKindSchema = z.enum([
  "PRIMITIVE",
  "OBJECT",
  "ARRAY",
  "REFERENCE",
  "ONE_OF",
  "ANY_OF",
  "ALL_OF",
]);

export const paramLocationSchema = z.enum(["header", "query", "cookie"]);

export const authTypeSchema = z.enum([
  "http",
  "apiKey",
  "oauth2",
  "openIdConnect",
]);

export const severitySchema = z.enum(["warning", "error"]);

export const constraintsSchema = z
  .object({
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.boolean().optional(),
    exclusiveMaximum: z.boolean().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    uniqueItems: z.boolean().optional(),
    pattern: z.string().optional(),
    enumValues: z.array(z.string()).optional(),
    multipleOf: z.number().positive().optional(),
  })
  .strict();

// Schema is recursive; declare with z.lazy.
export const schemaSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      kind: schemaKindSchema,
      refName: z.string().optional(),
      primitiveType: primitiveTypeSchema.optional(),
      format: z.string().optional(),
      properties: z.record(z.string(), schemaSchema).optional(),
      requiredProperties: z.array(z.string()).optional(),
      items: schemaSchema.optional(),
      variants: z.array(schemaSchema).optional(),
      constraints: constraintsSchema.optional(),
      nullable: z.boolean().optional(),
      description: z.string().optional(),
      defaultValue: z.string().optional(),
      example: z.string().optional(),
    })
    .strict(),
);

export const paramInfoSchema = z
  .object({
    name: z.string().min(1),
    schema: schemaSchema,
    required: z.boolean(),
    description: z.string().optional(),
    example: z.string().optional(),
  })
  .strict();

export const bodyInfoSchema = z
  .object({
    contentType: z.string().min(1),
    schema: schemaSchema,
    required: z.boolean(),
  })
  .strict();

export const responseInfoSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    description: z.string(),
    schema: schemaSchema.optional(),
    contentType: z.string().optional(),
    headers: z.record(z.string(), paramInfoSchema).optional(),
  })
  .strict();

export const authInfoSchema = z
  .object({
    type: authTypeSchema,
    scheme: z.string().optional(),
    name: z.string().optional(),
    in: paramLocationSchema.optional(),
    bearerFormat: z.string().optional(),
    id: z.string().min(1),
  })
  .strict();

export const sourceLocationSchema = z
  .object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  })
  .strict();

export const routeInfoSchema = z
  .object({
    method: httpMethodSchema,
    path: z.string().startsWith("/"),
    pathParams: z.array(paramInfoSchema).optional(),
    queryParams: z.array(paramInfoSchema).optional(),
    headerParams: z.array(paramInfoSchema).optional(),
    requestBody: bodyInfoSchema.optional(),
    responses: z.array(responseInfoSchema).optional(),
    auth: authInfoSchema.optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    operationId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    deprecated: z.boolean().optional(),
    source: sourceLocationSchema,
  })
  .strict();

export const parseErrorSchema = z
  .object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    message: z.string().min(1),
    severity: severitySchema,
    code: z.string().optional(),
  })
  .strict();

export const parserMetadataSchema = z
  .object({
    framework: z.string().min(1),
    frameworkVersion: z.string().optional(),
    filesScanned: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    parserVersion: z.string().min(1),
  })
  .strict();

export const parseResultSchema = z
  .object({
    routes: z.array(routeInfoSchema),
    errors: z.array(parseErrorSchema),
    metadata: parserMetadataSchema,
    sharedSchemas: z.record(z.string(), schemaSchema).optional(),
  })
  .strict();

// Friendly entry point used by parser-bridge: throws a typed error with a
// concise message pointing at the offending field.
export class IRValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "IRValidationError";
  }
}

export function parseIR(value: unknown): import("./ir.js").ParseResult {
  const result = parseResultSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") || "<root>";
    throw new IRValidationError(
      `Invalid ParseResult at \`${path}\`: ${first?.message ?? "unknown"}`,
      result.error.issues,
    );
  }
  return result.data as import("./ir.js").ParseResult;
}
