import { stringify } from "yaml";
import type { OpenApiDocument } from "./types.js";

export function toYaml(doc: OpenApiDocument): string {
  return stringify(doc, {
    indent: 2,
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}

export function toJson(doc: OpenApiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
