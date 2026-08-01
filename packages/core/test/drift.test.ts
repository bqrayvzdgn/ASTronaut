import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// IR drift guard. proto/parser.proto is the declared source of truth for the IR;
// ir.ts, validate.ts (zod), and IR.cs (the .NET analyzer's DTOs) are hand-synced
// to it. This test fails when a field exists in the proto but is missing from one
// of the three representations — the exact "added a proto field, forgot a mirror"
// mistake that otherwise ships silently. It is a name-presence check, not a full
// structural parse: cheap, and enough to catch omissions.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}/${rel}`, "utf8");

const proto = read("proto/parser.proto");
const irTs = read("packages/core/src/ir.ts");
const validateTs = read("packages/core/src/validate.ts");
const irCs = read("analyzers/dotnet/src/AsTronaut.Analyzer/Ir/IR.cs");

// Field declarations look like `[optional|repeated] <type> field_name = N;`
// (map<K,V> included). Enum values (`PRIMITIVE = 0;`) have no type token before
// the name and are naturally excluded.
function protoFieldNames(source: string): string[] {
  const re = /^\s*(?:optional\s+|repeated\s+)?(?:map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+\s*;/gm;
  const names = new Set<string>();
  for (const m of source.matchAll(re)) {
    const name = m[1];
    // Skip stray all-caps tokens (defensive against enum-like lines).
    if (name && name !== name.toUpperCase()) names.add(name);
  }
  return [...names];
}

const toCamel = (snake: string) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toPascal = (snake: string) => {
  const camel = toCamel(snake);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};
const hasWord = (source: string, word: string) => new RegExp(`\\b${word}\\b`).test(source);

describe("IR contract drift", () => {
  const fields = protoFieldNames(proto);

  it("extracts a plausible set of proto fields", () => {
    // Sanity check the regex itself so a parsing regression can't make the
    // presence checks vacuously pass.
    expect(fields).toContain("shared_schemas");
    expect(fields).toContain("path_params");
    expect(fields.length).toBeGreaterThan(30);
  });

  it("every proto field has a camelCase counterpart in ir.ts", () => {
    const missing = fields.filter((f) => !hasWord(irTs, toCamel(f)));
    expect(missing, `Missing from ir.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every proto field has a zod key in validate.ts", () => {
    const missing = fields.filter((f) => !hasWord(validateTs, toCamel(f)));
    expect(missing, `Missing from validate.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every proto field has a property in IR.cs", () => {
    // C# properties are PascalCase; the one camelCase override in IR.cs is spelled
    // via [JsonPropertyName], so accept either form.
    const missing = fields.filter((f) => !hasWord(irCs, toPascal(f)) && !hasWord(irCs, toCamel(f)));
    expect(missing, `Missing from IR.cs: ${missing.join(", ")}`).toEqual([]);
  });
});
