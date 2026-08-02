// Local OpenAPI 3.1 typing — only the subset we actually emit. Using a
// hand-rolled type instead of `openapi3-ts` because that package's optional
// fields are typed as `T | undefined`, which conflicts with the project's
// `exactOptionalPropertyTypes` setting.

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: InfoObject;
  paths?: Record<string, PathItemObject>;
  components?: ComponentsObject;
  tags?: TagObject[];
  security?: SecurityRequirementObject[];
}

export interface InfoObject {
  title: string;
  version: string;
  description?: string;
}

export interface TagObject {
  name: string;
  description?: string;
}

export interface PathItemObject {
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
  parameters?: ParameterObject[];
}

export interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  security?: SecurityRequirementObject[];
  deprecated?: boolean;
}

export interface ParameterObject {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  description?: string;
  required?: boolean;
  schema: SchemaObject;
  example?: unknown;
}

export interface RequestBodyObject {
  description?: string;
  content: Record<string, MediaTypeObject>;
  required?: boolean;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, HeaderObject>;
  content?: Record<string, MediaTypeObject>;
}

export interface HeaderObject {
  description?: string;
  required?: boolean;
  schema: SchemaObject;
  example?: unknown;
}

export interface MediaTypeObject {
  schema: SchemaObject;
}

// JSON Schema 2020-12 subset. The "type" field can be a string or an array of
// strings to express nullability (OpenAPI 3.1 convention).
export interface SchemaObject {
  $ref?: string;
  type?: SchemaType | SchemaType[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  additionalProperties?: SchemaObject | boolean;
  discriminator?: DiscriminatorObject;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  multipleOf?: number;
  default?: unknown;
  example?: unknown;
}

export type SchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface DiscriminatorObject {
  propertyName: string;
  mapping?: Record<string, string>;
}

export interface ComponentsObject {
  schemas?: Record<string, SchemaObject>;
  securitySchemes?: Record<string, SecuritySchemeObject>;
}

export interface SecuritySchemeObject {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlowsObject;
  openIdConnectUrl?: string;
}

// Per OpenAPI 3.1 an oauth2 scheme MUST carry a `flows` object. Each individual
// flow (implicit/password/clientCredentials/authorizationCode) is optional, so an
// empty `{}` is spec-valid — which is all we can honestly emit, since the concrete
// flow URLs live in Program.cs config and aren't statically recoverable.
export interface OAuthFlowsObject {
  implicit?: OAuthFlowObject;
  password?: OAuthFlowObject;
  clientCredentials?: OAuthFlowObject;
  authorizationCode?: OAuthFlowObject;
}

export interface OAuthFlowObject {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

export type SecurityRequirementObject = Record<string, string[]>;
