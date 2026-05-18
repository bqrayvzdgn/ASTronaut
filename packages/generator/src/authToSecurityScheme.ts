import type { AuthInfo } from "@astronaut/core";
import type { SecuritySchemeObject } from "./types.js";

export function authToSecurityScheme(auth: AuthInfo): SecuritySchemeObject {
  const out: SecuritySchemeObject = { type: auth.type };
  if (auth.scheme !== undefined) out.scheme = auth.scheme;
  if (auth.bearerFormat !== undefined) out.bearerFormat = auth.bearerFormat;
  if (auth.name !== undefined) out.name = auth.name;
  if (auth.in !== undefined) out.in = auth.in;
  return out;
}
