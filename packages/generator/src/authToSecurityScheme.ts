import type { AuthInfo } from "@astronaut/core";
import type { SecuritySchemeObject } from "./types.js";

const OIDC_PLACEHOLDER_URL = "https://example.com/.well-known/openid-configuration";

export function authToSecurityScheme(auth: AuthInfo): SecuritySchemeObject {
  const out: SecuritySchemeObject = { type: auth.type as SecuritySchemeObject["type"] };
  if (auth.scheme !== undefined) out.scheme = auth.scheme;
  if (auth.bearerFormat !== undefined) out.bearerFormat = auth.bearerFormat;
  if (auth.name !== undefined) out.name = auth.name;
  if (auth.in !== undefined) out.in = auth.in as NonNullable<SecuritySchemeObject["in"]>;
  if (auth.type === "oauth2") out.flows = {};
  if (auth.type === "openIdConnect") out.openIdConnectUrl = OIDC_PLACEHOLDER_URL;
  return out;
}
