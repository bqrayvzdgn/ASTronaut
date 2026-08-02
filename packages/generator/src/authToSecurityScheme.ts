import type { AuthInfo } from "@astronaut/core";
import type { SecuritySchemeObject } from "./types.js";

// OpenAPI 3.1 marks two sub-fields as REQUIRED that a bare [Authorize] can't
// supply, since the real values live in Program.cs runtime config:
//   - oauth2         → `flows` (an OAuth Flows Object)
//   - openIdConnect  → `openIdConnectUrl` (a URL)
// Without them the emitted scheme fails the 3.1 meta-schema. We emit the minimal
// spec-valid stand-ins: an empty `flows: {}` (every individual flow is optional)
// and a documented placeholder discovery URL. The placeholder is deliberately a
// well-formed, obviously-not-real URL so consumers know to substitute their own.
const OIDC_PLACEHOLDER_URL = "https://example.com/.well-known/openid-configuration";

export function authToSecurityScheme(auth: AuthInfo): SecuritySchemeObject {
  const out: SecuritySchemeObject = { type: auth.type };
  if (auth.scheme !== undefined) out.scheme = auth.scheme;
  if (auth.bearerFormat !== undefined) out.bearerFormat = auth.bearerFormat;
  if (auth.name !== undefined) out.name = auth.name;
  if (auth.in !== undefined) out.in = auth.in;
  if (auth.type === "oauth2") out.flows = {};
  if (auth.type === "openIdConnect") out.openIdConnectUrl = OIDC_PLACEHOLDER_URL;
  return out;
}
