import type { AuthInfo } from "@astronaut/core";
import type { SecuritySchemeObject } from "./types.js";

const OIDC_PLACEHOLDER_URL = "https://example.com/.well-known/openid-configuration";
const OAUTH2_TOKEN_URL_PLACEHOLDER = "https://example.com/oauth/token";

export function authToSecurityScheme(auth: AuthInfo): SecuritySchemeObject {
  const out: SecuritySchemeObject = { type: auth.type as SecuritySchemeObject["type"] };
  if (auth.scheme !== undefined) out.scheme = auth.scheme;
  if (auth.bearerFormat !== undefined) out.bearerFormat = auth.bearerFormat;
  if (auth.name !== undefined) out.name = auth.name;
  if (auth.in !== undefined) out.in = auth.in as NonNullable<SecuritySchemeObject["in"]>;
  if (auth.type === "oauth2") {
    out.flows = { clientCredentials: { tokenUrl: OAUTH2_TOKEN_URL_PLACEHOLDER, scopes: {} } };
    out.description = "OAuth2 flow details could not be inferred from source; placeholder tokenUrl.";
  }
  if (auth.type === "openIdConnect") {
    out.openIdConnectUrl = OIDC_PLACEHOLDER_URL;
    out.description = "OpenID Connect discovery URL could not be inferred from source; placeholder value.";
  }
  return out;
}
