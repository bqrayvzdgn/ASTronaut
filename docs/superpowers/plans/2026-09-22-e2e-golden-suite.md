# E2E Golden Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerçek C# fixture'larını analyzer → IR → generator hattından geçirip çıktıyı commit edilmiş golden'larla, OpenAPI 3.1 meta-şemasıyla ve yeniden kullanılabilir invariant kontrolleriyle doğrulayan; CLI sözleşmesini (exit kodları, stdout/stderr, opsiyonlar) gerçek binary üzerinden test eden; Linux ve Windows CI'da koşan bir E2E paketi.

**Architecture:** Invariant kontrolleri `packages/generator/src/invariants.ts` içinde saf, bağımlılıksız bir fonksiyon olarak yaşar ve paketten export edilir. `apps/cli/test/pipeline.e2e.test.ts` her fixture için `analyzeCommand`'ın adımlarını süreç içinde koşturup `fixtures/dotnet/<ad>/expected.openapi.yaml` ile karşılaştırır; `apps/cli/test/cli.e2e.test.ts` gerçek `apps/cli/dist/bin.js`'i alt süreç olarak çalıştırır. Analyzer'da iki küçük sıralama düzeltmesi çıktıyı OS'ten bağımsız kararlı yapar.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest 2.1 (`toMatchFileSnapshot`), biome 1.9, pnpm 10.33, .NET 8 SDK + Roslyn/MSBuildWorkspace (analyzer), xUnit (analyzer testleri), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-22-e2e-golden-suite-design.md`

## Global Constraints

- Fixture projeleri `net8.0`; web projeleri `Microsoft.NET.Sdk.Web`, kütüphane `Microsoft.NET.Sdk`; **hiçbir fixture'da NuGet `PackageReference` yok** (üçüncü parti attribute'lar stub'lanır).
- Yeni npm bağımlılığı yok (`apps/cli`'ye YAML ayrıştırıcı eklenmez; `@seriousme/openapi-schema-validator` zaten devDependency).
- TS: `verbatimModuleSyntax` → tipler `import type` ile; `noUncheckedIndexedAccess` → indeksli erişim `undefined` olabilir; `exactOptionalPropertyTypes` → opsiyonel alana `undefined` atanmaz.
- biome: `useImportType`, `useNodejsImportProtocol` (`node:fs`), `noExplicitAny` hata; formatter `lineWidth: 100`, çift tırnak, noktalı virgül. Her TS görevinden sonra `pnpm lint:fix` + `pnpm lint`.
- Satır sonu LF (`.gitattributes`: `* text=auto eol=lf`); golden karşılaştırmasında `\r\n` → `\n` normalize edilir.
- Fixture dosya/dizin adları ASCII ve `Ordinal` ile `localeCompare` sıralamasının aynı sonucu vereceği biçimde (A14).
- Golden'ı olmayan tek fixture `diagnostics-load-failure`; golden testi bunu `FAILURE_FIXTURES` ile dışlar.
- `pnpm test:e2e` toplam süresi hedefi ≈ 60 sn altı; `vitest.e2e.config.ts`'de dosyalar **sıralı** koşar (`fileParallelism: false`) — MSBuild yüklemeleri aynı `obj/` dizinlerine dokunabilir.
- Commit mesajları İngilizce, `type(scope): subject` biçiminde; her commit şu trailer ile biter: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push ve PR **kullanıcı onayıyla** (Task 13).
- Ürün koduna dokunan tek yer analyzer sıralama düzeltmesi (Task 3) ve generator'a eklenen invariant modülü (Task 2). Golden üretirken görülen şüpheli analyzer çıktıları **düzeltilmez**, Task 13 raporuna "bulgu" olarak yazılır.

## Review Focus

1. **Yetim golden:** bir fixture silinir ama `expected.openapi.yaml` kalırsa sessizce geçmemeli → Task 5, "has no orphaned golden files" testi.
2. **Sessizce bozulmuş fixture:** restore/derleme hatası W003 üretip tipleri `object`'e düşürürse golden yanlış üretilir → Task 5, `diagnostics-*` dışındaki fixture'larda **hiç diagnostic olmamalı** assertion'ı.
3. **Sıfır route'lu fixture:** boş bir belge "geçerli" sayılmamalı → Task 5, `routes.length > 0` assertion'ı; Task 11, `Contracts.csproj` → exit 1 "0 routes".
4. **Boşluklu / iç içe çıktı yolu:** `-o "nested dir/spec.yaml"` dizinleri oluşturup yazmalı → Task 11, 1. senaryo.
5. **`--json` + `-o` birlikte:** dosyaya JSON yazılmalı, YAML değil → Task 11, 4. senaryo.

Kapsam dışı ama not: route template'inde C# parametresine bağlanmamış bir `{placeholder}` analyzer tarafından nasıl ele alınıyor, fixture'larla zorlanmaz; doküman düzeyinde `path-params-match-template` kuralı yakalar, analyzer davranışı canlı testte (alt proje 4) gözlenir.

---

### Task 1: Branch ve spec commit'i

**Files:**
- Commit: `docs/superpowers/specs/2026-09-22-e2e-golden-suite-design.md` (zaten yazıldı, untracked)

**Interfaces:**
- Consumes: —
- Produces: `feat/e2e-golden-suite` branch'i; sonraki tüm görevler bu branch'te çalışır.

- [ ] **Step 1: Temiz ağaçtan branch aç**

Run: `cd /c/dev/ASTronaut && git status --porcelain && git checkout -b feat/e2e-golden-suite`
Expected: `git status --porcelain` yalnız `?? docs/superpowers/` gösterir; `Switched to a new branch 'feat/e2e-golden-suite'`.

- [ ] **Step 2: Spec'i commit'le**

```bash
cd /c/dev/ASTronaut
git add docs/superpowers/specs/2026-09-22-e2e-golden-suite-design.md
git commit -m "docs: add E2E golden suite design spec" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Expected: 1 file changed.

---

### Task 2: Invariant modülü (`packages/generator`)

**Files:**
- Create: `packages/generator/src/invariants.ts`
- Modify: `packages/generator/src/index.ts` (export ekle)
- Test: `packages/generator/test/invariants.test.ts`

**Interfaces:**
- Consumes: `OpenApiDocument`, `SchemaObject`, `ParameterObject`, `OperationObject`, `SecurityRequirementObject`, `SecuritySchemeObject` (`packages/generator/src/types.ts`).
- Produces: `checkOpenApiInvariants(doc: OpenApiDocument): InvariantViolation[]`, `type InvariantRule`, `interface InvariantViolation { rule; path; message }` — `@astronaut/generator`'dan export edilir; Task 5 ve alt proje 4 kullanır.

- [ ] **Step 1: Kırmızı testi yaz**

`packages/generator/test/invariants.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIR } from "@astronaut/core";
import { describe, expect, it } from "vitest";
import type {
  ComponentsObject,
  InvariantRule,
  OpenApiDocument,
  ParameterObject,
  PathItemObject,
  ResponseObject,
  SchemaObject,
} from "../src/index.js";
import { checkOpenApiInvariants, toOpenApi } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// The smallest document that satisfies every rule. Each violating case below
// starts from it and breaks exactly one rule, so a failure names the rule.
function conformingDoc(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Invariants", version: "1.0.0" },
    paths: {
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
          security: [{ bearerAuth: [] }],
        },
      },
    },
    components: {
      schemas: {
        User: { type: "object", properties: { name: { type: ["string", "null"] } } },
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  };
}

function idParam(): ParameterObject {
  return { name: "id", in: "path", required: true, schema: { type: "integer" } };
}

function ok(): Record<string, ResponseObject> {
  return { "200": { description: "OK" } };
}

function withPaths(paths: Record<string, PathItemObject>): OpenApiDocument {
  return { ...conformingDoc(), paths };
}

function withComponents(components: ComponentsObject): OpenApiDocument {
  const base = conformingDoc();
  return { ...base, components: { ...base.components, ...components } };
}

// A 3.0-style schema the emitter must never produce; cast because the 3.1
// SchemaObject type (correctly) has no `nullable` field.
const legacyNullable = { type: "string", nullable: true } as unknown as SchemaObject;

const violations: Array<[InvariantRule, OpenApiDocument]> = [
  [
    "unique-operation-ids",
    withPaths({
      "/users/{id}": {
        get: { operationId: "GetUser", parameters: [idParam()], responses: ok() },
        delete: { operationId: "GetUser", parameters: [idParam()], responses: ok() },
      },
    }),
  ],
  [
    "unique-parameters",
    withPaths({
      "/users/{id}": {
        get: { operationId: "GetUser", parameters: [idParam(), idParam()], responses: ok() },
      },
    }),
  ],
  [
    "resolvable-refs",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
              },
            },
          },
        },
      },
    }),
  ],
  [
    "resolvable-refs",
    withComponents({
      schemas: {
        User: {
          oneOf: [{ $ref: "#/components/schemas/User" }],
          discriminator: { propertyName: "kind", mapping: { x: "#/components/schemas/Nope" } },
        },
      },
    }),
  ],
  [
    "path-params-match-template",
    withPaths({ "/users/{id}": { get: { operationId: "GetUser", responses: ok() } } }),
  ],
  [
    "path-params-match-template",
    withPaths({
      "/users": { get: { operationId: "GetUser", parameters: [idParam()], responses: ok() } },
    }),
  ],
  [
    "path-params-match-template",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [{ name: "id", in: "path", schema: { type: "integer" } }],
          responses: ok(),
        },
      },
    }),
  ],
  [
    "security-schemes-defined",
    withPaths({
      "/users/{id}": {
        get: {
          operationId: "GetUser",
          parameters: [idParam()],
          responses: ok(),
          security: [{ apiKey: [] }],
        },
      },
    }),
  ],
  [
    "security-schemes-defined",
    withComponents({
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" }, oauth2: { type: "oauth2" } },
    }),
  ],
  [
    "security-schemes-defined",
    withComponents({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        oidc: { type: "openIdConnect" },
      },
    }),
  ],
  [
    "nullable-3-1-style",
    withComponents({
      schemas: { User: { type: "object", properties: { name: legacyNullable } } },
    }),
  ],
  [
    "no-empty-schema",
    withComponents({ schemas: { User: { type: "object", properties: { name: {} } } } }),
  ],
];

describe("checkOpenApiInvariants", () => {
  it("accepts a conforming document", () => {
    expect(checkOpenApiInvariants(conformingDoc())).toEqual([]);
  });

  it.each(violations)("flags %s and nothing else", (rule, doc) => {
    const rules = new Set(checkOpenApiInvariants(doc).map((v) => v.rule));
    expect(rules).toEqual(new Set([rule]));
  });

  it("reports a readable location", () => {
    const [violation] = checkOpenApiInvariants(
      withComponents({ schemas: { User: { type: "object", properties: { name: {} } } } }),
    );
    expect(violation?.path).toBe("components.schemas.User.properties.name");
  });

  it.each(["single-route", "route-with-body", "shared-schemas", "all-features"])(
    "generator fixture %s yields an invariant-clean document",
    (name) => {
      const raw = readFileSync(join(here, "fixtures", `${name}.json`), "utf8");
      const doc = toOpenApi(parseIR(JSON.parse(raw)), { title: name, version: "1.0.0" });
      expect(checkOpenApiInvariants(doc)).toEqual([]);
    },
  );
});
```

- [ ] **Step 2: Testin kırmızı olduğunu gör**

Run: `cd /c/dev/ASTronaut && pnpm exec vitest run packages/generator/test/invariants.test.ts`
Expected: FAIL — `"checkOpenApiInvariants" is not exported by "packages/generator/src/index.ts"` (veya eşdeğer import hatası).

- [ ] **Step 3: Modülü yaz**

`packages/generator/src/invariants.ts`:

```ts
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
```

`packages/generator/src/index.ts` — mevcut `toJson, toYaml` export satırının altına ekle:

```ts
export { checkOpenApiInvariants } from "./invariants.js";
export type { InvariantRule, InvariantViolation } from "./invariants.js";
```

- [ ] **Step 4: Testin yeşil olduğunu gör**

Run: `cd /c/dev/ASTronaut && pnpm exec vitest run packages/generator/test/invariants.test.ts`
Expected: PASS — 1 + 12 + 1 + 4 = 18 test. Eğer "generator fixture … invariant-clean" testlerinden biri düşerse bu bir bulgudur: ihlali okuyup fixture'ın gerçekten degenerate bir şema içerip içermediğine bak; kuralı gevşetme, Task 13 raporuna yaz ve o fixture'ı `it.each` listesinden **yorum satırıyla gerekçelendirerek** çıkar.

- [ ] **Step 5: Lint + build + tüm unit testler**

Run: `cd /c/dev/ASTronaut && pnpm lint:fix && pnpm lint && pnpm build && pnpm test`
Expected: lint temiz; build 4 paket; `Tests … passed` (önceki 51 + 18).

- [ ] **Step 6: Commit**

```bash
cd /c/dev/ASTronaut
git add packages/generator/src/invariants.ts packages/generator/src/index.ts packages/generator/test/invariants.test.ts
git commit -m "feat(generator): add checkOpenApiInvariants for OpenAPI 3.1 documents" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Analyzer determinizmi (tree ve proje sıralaması)

**Files:**
- Modify: `analyzers/dotnet/src/AsTronaut.Analyzer/Controllers/ControllerWalker.cs:53-56` (`Walk` döngüsü)
- Modify: `analyzers/dotnet/src/AsTronaut.Analyzer/Discovery/ProjectLoader.cs:110-113` (`OpenSolutionAsync` sonucu)
- Modify: `analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/Support/TestCompilation.cs` (`WalkFiles` yardımcısı)
- Test: `analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/DeterminismTests.cs`

**Interfaces:**
- Consumes: `ControllerWalker(Compilation, string repoRoot, SchemaContext)`, `WalkResult` (Support).
- Produces: `TestCompilation.WalkFiles(params (string Path, string Source)[] files): WalkResult`; analyzer çıktısında route/şema sırası Ordinal dosya-yolu sırası (Task 6-7 golden'ları buna dayanır).

- [ ] **Step 1: Test yardımcısını ekle**

`Support/TestCompilation.cs` içinde `Walk(string source, string repoRoot = "")` metodunun hemen altına:

```csharp
    // Multi-file variant: one syntax tree per (path, source) pair, added to the
    // compilation in the order given. Lets tests prove the walker's output does
    // not depend on the order MSBuild happens to hand over documents.
    public static WalkResult WalkFiles(params (string Path, string Source)[] files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(
            f.Source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: f.Path));

        var compilation = CSharpCompilation.Create(
            assemblyName: "AsTronaut.Analyzer.TestInput",
            syntaxTrees: trees,
            references: References.Value,
            options: new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));

        var schemaContext = new SchemaContext();
        var walker = new ControllerWalker(compilation, "", schemaContext);
        walker.Walk();
        return new WalkResult(walker.Routes.ToList(), walker.Errors.ToList(), schemaContext.SharedSchemas);
    }
```

- [ ] **Step 2: Kırmızı testi yaz**

`analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/DeterminismTests.cs`:

```csharp
using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Q7: the emitted document must not depend on the order MSBuild hands documents
// to the analyzer — that order differs by OS and file system and would make
// golden e2e output flaky across machines. Order inside a file stays source order.
public class DeterminismTests
{
    private const string ZebraController = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("zebra")]
        public class ZebraController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    private const string AppleController = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("apple")]
        public class AppleController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    private const string BothControllersZebraFirst = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("zebra")]
        public class ZebraController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }

        [ApiController]
        [Route("apple")]
        public class AppleController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    [Fact]
    public void Walk_FilesGivenInReverseOrder_EmitsRoutesInFilePathOrder()
    {
        // Arrange: the compilation receives the files in the "wrong" order.
        var result = TestCompilation.WalkFiles(
            ("Controllers/Zebra.cs", ZebraController),
            ("Controllers/Apple.cs", AppleController));

        // Act
        var paths = result.Routes.Select(r => r.Path).ToList();

        // Assert: Ordinal file-path order wins over insertion order.
        Assert.Equal(new[] { "/apple", "/zebra" }, paths);
    }

    [Fact]
    public void Walk_ControllersInOneFile_KeepsSourceOrder()
    {
        // Arrange: Zebra is declared before Apple inside a single file.
        var result = TestCompilation.WalkFiles(("Controllers/Both.cs", BothControllersZebraFirst));

        // Act
        var paths = result.Routes.Select(r => r.Path).ToList();

        // Assert
        Assert.Equal(new[] { "/zebra", "/apple" }, paths);
    }
}
```

- [ ] **Step 3: Kırmızıyı gör**

Run: `cd /c/dev/ASTronaut && dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/AsTronaut.Analyzer.Tests.csproj -c Release --filter "FullyQualifiedName~DeterminismTests"`
Expected: 1 failed (`Walk_FilesGivenInReverseOrder…`: expected `/apple, /zebra` got `/zebra, /apple`), 1 passed.

- [ ] **Step 4: Walker'ı sırala**

`ControllerWalker.cs`, `Walk()` içinde şu satırı:

```csharp
        foreach (var tree in _compilation.SyntaxTrees)
```

şununla değiştir:

```csharp
        // Documents arrive in whatever order MSBuild enumerated them, which differs
        // by OS and file system. Walk them in Ordinal file-path order so route and
        // schema order (and therefore the emitted document) is stable everywhere;
        // order inside a file is still source order.
        var trees = _compilation.SyntaxTrees.OrderBy(t => t.FilePath, StringComparer.Ordinal);
        foreach (var tree in trees)
```

- [ ] **Step 5: Solution projelerini sırala**

`ProjectLoader.cs`, `OpenSolutionProjectsAsync` içinde:

```csharp
                var solution = await workspace.OpenSolutionAsync(path);
                return solution.Projects.ToList();
```

şununla değiştir:

```csharp
                var solution = await workspace.OpenSolutionAsync(path);
                // Roslyn returns projects in solution-file order, which is whatever
                // the author (or tooling) happened to write. Sort by path so route
                // and schema order — and the "bare" name a colliding DTO wins — is
                // the same on every machine.
                return solution.Projects
                    .OrderBy(p => p.FilePath ?? "", StringComparer.Ordinal)
                    .ToList();
```

- [ ] **Step 6: Tüm analyzer testleri yeşil**

Run: `cd /c/dev/ASTronaut && dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/AsTronaut.Analyzer.Tests.csproj -c Release`
Expected: `Passed! - Failed: 0, Passed: 73` (71 + 2).

- [ ] **Step 7: Analyzer'ı yeniden publish et ve mevcut e2e hâlâ yeşil**

Run: `cd /c/dev/ASTronaut && pnpm build:analyzers && pnpm test:e2e`
Expected: `Built: …/analyzers/dotnet/dist/AsTronaut.Analyzer.dll`; e2e 3 passed (mevcut tek dosyalı fixture'lar etkilenmez).

- [ ] **Step 8: Commit**

```bash
cd /c/dev/ASTronaut
git add analyzers/dotnet/src/AsTronaut.Analyzer/Controllers/ControllerWalker.cs analyzers/dotnet/src/AsTronaut.Analyzer/Discovery/ProjectLoader.cs analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/Support/TestCompilation.cs analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/DeterminismTests.cs
git commit -m "fix(analyzer): walk syntax trees and solution projects in Ordinal path order" -m "Route and schema order no longer depends on MSBuild's document enumeration order, which differs by OS (Q7). Needed for byte-stable golden e2e output." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Fixture restore script'leri

**Files:**
- Create: `scripts/restore-fixtures.sh`
- Create: `scripts/restore-fixtures.ps1`
- Modify: `package.json` (`scripts.restore:fixtures`)

**Interfaces:**
- Consumes: —
- Produces: `pnpm restore:fixtures` — yerelde ve CI'da (Task 12) fixture restore'unun tek kaynağı.

- [ ] **Step 1: Bash script**

`scripts/restore-fixtures.sh`:

```bash
#!/usr/bin/env bash
# Restores every e2e fixture project (fixtures/dotnet/**/*.csproj) so
# MSBuildWorkspace can load them on a fresh checkout — obj/ is gitignored.
# Solutions need no separate step: restoring each .csproj covers them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
find "$ROOT/fixtures/dotnet" -name '*.csproj' -not -path '*/bin/*' -not -path '*/obj/*' -print0 \
  | xargs -0 -n1 dotnet restore
```

- [ ] **Step 2: PowerShell script**

`scripts/restore-fixtures.ps1`:

```powershell
# PowerShell sibling of scripts/restore-fixtures.sh — restores every e2e fixture
# project (fixtures/dotnet/**/*.csproj) without needing bash on Windows.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$fixtures = Join-Path $root 'fixtures/dotnet'
Get-ChildItem -Path $fixtures -Recurse -Filter *.csproj |
  Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' } |
  ForEach-Object {
    dotnet restore $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed for $($_.FullName)" }
  }
```

- [ ] **Step 3: package.json script**

`package.json` › `scripts`, `"build:analyzers"` satırının altına:

```json
    "restore:fixtures": "bash scripts/restore-fixtures.sh",
```

- [ ] **Step 4: Her iki script'i çalıştır**

Run: `cd /c/dev/ASTronaut && pnpm restore:fixtures && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-fixtures.ps1`
Expected: her ikisi de üç fixture için `Restored …csproj` yazar, exit 0. (`git status`'ta yalnız script dosyaları ve `package.json` görünür; `obj/` gitignore'da.)

- [ ] **Step 5: Lint (package.json biome tarafından biçimlenir) ve commit**

```bash
cd /c/dev/ASTronaut && pnpm lint
git add scripts/restore-fixtures.sh scripts/restore-fixtures.ps1 package.json
git commit -m "chore: add restore-fixtures scripts for e2e fixture projects" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Golden pipeline testi + test desteği + mevcut fixture golden'ları

**Files:**
- Create: `apps/cli/test/support/runCli.ts`
- Rewrite: `apps/cli/test/pipeline.e2e.test.ts`
- Modify: `vitest.e2e.config.ts` (`fileParallelism: false`)
- Create (üretilir): `fixtures/dotnet/controllers-basic/expected.openapi.yaml`, `fixtures/dotnet/controllers-rich/expected.openapi.yaml`, `fixtures/dotnet/controllers-route-params/expected.openapi.yaml`

**Interfaces:**
- Consumes: `checkOpenApiInvariants`, `toOpenApi`, `toYaml` (`@astronaut/generator`); `runAnalyzer`, `resolveDotnetAnalyzer` (`@astronaut/parser-bridge`); `detectAspnetProject` (`apps/cli/src/detect.ts`); `readProjectInfoFor` (`apps/cli/src/projectInfo.ts`).
- Produces: `apps/cli/test/support/runCli.ts` → `repoRoot`, `fixturesDir`, `cliBin`, `GOLDEN_FILE`, `fixturePath(name, ...segments)`, `goldenPath(fixture)`, `normalizeEol(text)`, `runCli(args, { cwd?, env? }): Promise<{ code; stdout; stderr }>` — Task 11 kullanır. `FAILURE_FIXTURES` seti (Task 10 ekler).

- [ ] **Step 1: Test desteğini yaz**

`apps/cli/test/support/runCli.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/cli/test/support/ → repo root is four levels up.
export const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
export const fixturesDir = join(repoRoot, "fixtures", "dotnet");
export const cliBin = join(repoRoot, "apps", "cli", "dist", "bin.js");

// Committed expectation next to each fixture; regenerate deliberately with
// `pnpm test:e2e -u` and review the diff.
export const GOLDEN_FILE = "expected.openapi.yaml";

export function fixturePath(name: string, ...segments: string[]): string {
  return join(fixturesDir, name, ...segments);
}

export function goldenPath(fixture: string): string {
  return fixturePath(fixture, GOLDEN_FILE);
}

// Goldens are committed with LF (.gitattributes); this guards a CRLF checkout.
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the built CLI (apps/cli/dist/bin.js) as a child process and resolves with
// its exit code and captured streams. Never rejects on a non-zero exit — exit
// codes are part of the contract under test.
export function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  if (!existsSync(cliBin)) {
    throw new Error(`CLI is not built (${cliBin}). Run \`pnpm build\` first.`);
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliBin, ...args],
      {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}
```

- [ ] **Step 2: e2e dosyalarını sıralı koştur**

`vitest.e2e.config.ts` › `test` nesnesine ekle:

```ts
    // Both e2e files spawn the analyzer over the same fixture projects; MSBuild
    // design-time builds may touch the same obj/ folders, so run files one at a time.
    fileParallelism: false,
```

- [ ] **Step 3: Pipeline testini yeniden yaz**

`apps/cli/test/pipeline.e2e.test.ts` (tamamı):

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkOpenApiInvariants, toOpenApi, toYaml } from "@astronaut/generator";
import { resolveDotnetAnalyzer, runAnalyzer } from "@astronaut/parser-bridge";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { detectAspnetProject } from "../src/detect.js";
import { readProjectInfoFor } from "../src/projectInfo.js";
import { GOLDEN_FILE, fixturesDir, goldenPath, normalizeEol, repoRoot } from "./support/runCli.js";

// Full pipeline over the checked-in fixture projects, in-process — the same
// steps `analyzeCommand` runs, so IR/zod errors surface directly:
//   real C# source → analyzer → ParseResult JSON → parseIR → toOpenApi → toYaml
//
// Three gates per fixture:
//   1. Golden: the emitted YAML matches fixtures/dotnet/<name>/expected.openapi.yaml
//      byte for byte. Update deliberately with `pnpm test:e2e -u`, then review the diff.
//   2. Spec validity: the OpenAPI 3.1 meta-schema.
//   3. Invariants the meta-schema cannot express (docs/test-scenarios.md §T).
// The CLI process itself is checked against the same goldens in cli.e2e.test.ts.

// Fixtures that must NOT produce a document (the CLI exits non-zero). They are
// covered by cli.e2e.test.ts and skipped here.
const FAILURE_FIXTURES = new Set<string>([]);

// The analyzer must be built (`pnpm build:analyzers`). Skip cleanly otherwise so
// the suite does not require a .NET toolchain just to load.
let analyzerBuilt = false;
try {
  analyzerBuilt = existsSync(resolveDotnetAnalyzer({ repoRootHint: repoRoot }));
} catch {
  analyzerBuilt = false;
}

const fixtureDirs = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

// Reuses the CLI's own detection so non-project dirs are skipped exactly as the
// CLI would skip them.
const fixtures = fixtureDirs
  .filter((name) => !FAILURE_FIXTURES.has(name))
  .filter((name) => detectAspnetProject(join(fixturesDir, name)) !== null);

describe.skipIf(!analyzerBuilt)("pipeline: fixture → analyzer → IR → OpenAPI 3.1", () => {
  if (!analyzerBuilt) {
    it("skipped — run `pnpm build:analyzers` to enable", () => {});
    return;
  }

  it("finds the fixture projects", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // A golden whose fixture was removed (or stopped being analyzable) would
  // otherwise linger and pass silently.
  it("has no orphaned golden files", () => {
    const orphans = fixtureDirs
      .filter((name) => existsSync(join(fixturesDir, name, GOLDEN_FILE)))
      .filter((name) => !fixtures.includes(name));
    expect(orphans).toEqual([]);
  });

  it.each(fixtures)("%s", async (fixture) => {
    const projectPath = join(fixturesDir, fixture);
    const detected = detectAspnetProject(projectPath);
    expect(detected).not.toBeNull();
    if (detected === null) return;

    // runAnalyzer validates the analyzer's stdout through the zod IR schema.
    const result = await runAnalyzer({ projectPath, repoRootHint: repoRoot });

    // An empty or degraded result would still yield a "valid" document — fail
    // loudly instead. Only diagnostics-* fixtures may warn (that is their job);
    // a warning elsewhere usually means the fixture failed to restore/compile.
    expect(result.routes.length, `${fixture}: analyzer found no routes`).toBeGreaterThan(0);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors, `${fixture}: analyzer reported errors`).toEqual([]);
    if (!fixture.startsWith("diagnostics-")) {
      expect(result.errors, `${fixture}: unexpected diagnostics`).toEqual([]);
    }

    const info = readProjectInfoFor(detected);
    const doc = toOpenApi(result, {
      title: info.title,
      version: info.version,
      ...(info.description !== undefined ? { description: info.description } : {}),
    });

    await expect(normalizeEol(toYaml(doc))).toMatchFileSnapshot(goldenPath(fixture));

    const validation = await new Validator().validate(doc as unknown as Record<string, unknown>);
    expect(validation.valid, `${fixture}: ${JSON.stringify(validation.errors, null, 2)}`).toBe(
      true,
    );

    expect(checkOpenApiInvariants(doc)).toEqual([]);
  });
});
```

- [ ] **Step 4: Generator'ı yeniden derle (invariant export'u dist'e girsin) ve e2e'yi koştur — golden'lar üretilir**

Run: `cd /c/dev/ASTronaut && pnpm build && pnpm test:e2e`
Expected: PASS; vitest üç yeni snapshot dosyası yazdığını raporlar (`3 written` benzeri özet) ve `fixtures/dotnet/{controllers-basic,controllers-rich,controllers-route-params}/expected.openapi.yaml` oluşur. `CI` ortam değişkeni set ise vitest yeni snapshot yazmaz: `CI= pnpm test:e2e` ile koştur.

- [ ] **Step 5: Golden'ları elle incele**

Her üç dosyayı aç ve şunları doğrula (bunlar spike'ta gözlenen çıktıyla tutarlı olmalı):
- `controllers-basic`: `title: ControllersBasic`, 2 path (`/api/users`, `/api/users/{id}`), 4 operation, şemalar `User` (email required, name nullable `[string, null]`) ve `CreateUserDto`.
- `controllers-rich`: `title: ControllersRich`, `/api/orders`, `/api/orders/{id}`, `/health`; `summary`/`description` XML doc'tan; `securitySchemes.bearerAuth`; `/health` üzerinde `security` yok (AllowAnonymous); `CreateOrderDto.customerEmail` üzerinde `format: email`, `minLength: 3`, `maxLength: 120`; `currency` üzerinde `pattern`.
- `controllers-route-params`: `/api/v1/Items/{id}` (`minimum: 1`), `by-uuid/{uuid}` (`format: uuid`), `by-slug/{slug}` (`minLength: 3`, `maxLength: 40`), `search` (q/page/size query), `traced` (`X-Trace-Id` header).
Beklenmeyen bir şey görürsen değiştirme; Task 13 raporuna "bulgu" olarak not al.

- [ ] **Step 6: Golden gerçekten kapı mı ve `-u` vitest'e ulaşıyor mu?**

```bash
cd /c/dev/ASTronaut
printf '# tamper\n' >> fixtures/dotnet/controllers-basic/expected.openapi.yaml
pnpm test:e2e; echo "without -u exit=$?"
pnpm test:e2e -u; echo "with -u exit=$?"
grep -c tamper fixtures/dotnet/controllers-basic/expected.openapi.yaml
```
Expected: ilk koşu FAIL (`controllers-basic` golden uyuşmazlığı, `without -u exit=1`); ikinci koşu PASS ve golden'ı geri yazar; `grep -c` → `0`. Eğer ikinci koşu da FAIL ise pnpm bayrağı iletmiyordur: `pnpm test:e2e -- -u` ile tekrar dene ve çalışan biçimi Task 12'deki README/doküman metinlerine **o biçimde** yaz.

- [ ] **Step 7: Tekrarlanabilirlik: bir sonraki koşu hiçbir şey yazmamalı**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e && git status --porcelain fixtures`
Expected: PASS, snapshot özetinde `written`/`updated` yok; `git status` yalnız üç `?? …/expected.openapi.yaml` gösterir.

- [ ] **Step 8: Lint + commit**

```bash
cd /c/dev/ASTronaut && pnpm lint:fix && pnpm lint
git add apps/cli/test/support/runCli.ts apps/cli/test/pipeline.e2e.test.ts vitest.e2e.config.ts fixtures/dotnet/controllers-basic/expected.openapi.yaml fixtures/dotnet/controllers-rich/expected.openapi.yaml fixtures/dotnet/controllers-route-params/expected.openapi.yaml
git commit -m "test(e2e): golden + invariant pipeline test with CLI test support" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Fixture `controllers-features` (Grup 1 + enum + polimorfizm + versiyonlama)

**Files:**
- Create: `fixtures/dotnet/controllers-features/ControllersFeatures.csproj`
- Create: `fixtures/dotnet/controllers-features/Program.cs`
- Create: `fixtures/dotnet/controllers-features/Controllers/ProductsController.cs`
- Create: `fixtures/dotnet/controllers-features/Controllers/ReportsController.cs`
- Create: `fixtures/dotnet/controllers-features/Controllers/ShapesController.cs`
- Create: `fixtures/dotnet/controllers-features/Versioning/AspVersioningStubs.cs`
- Create (üretilir): `fixtures/dotnet/controllers-features/expected.openapi.yaml`

**Interfaces:**
- Consumes: Task 3 (dosya sırası), Task 5 (golden testi).
- Produces: e2e'de Grup 1 kapsamı; fixture adı Task 12 dokümantasyonunda kullanılır.

- [ ] **Step 1: Proje dosyaları**

`ControllersFeatures.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
</Project>
```

`Program.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);
builder.Services
    .AddControllers()
    .AddJsonOptions(options =>
    {
        // I29: global naming policy → every schema property is snake_case.
        options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
        // J2: enums serialize as strings → string schemas listing member names.
        options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    });

var app = builder.Build();
app.MapControllers();
app.Run();
```

- [ ] **Step 2: Controller'lar**

`Controllers/ProductsController.cs`:

```csharp
using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// Grup 1 binding & schema fidelity on a real compilation:
//   E12 [AsParameters] flatten · E3 Name overrides · E15/J2 enum query param ·
//   G36 [ProducesResponseType] completed from the body · I3 record struct ·
//   L3b/L15 [MaxLength] on a collection vs a string · I29 snake_case names.
[ApiController]
[Route("api/products")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(200)]
    public IActionResult List(
        [AsParameters] ProductQuery query,
        [FromHeader(Name = "X-Tenant-Id")] string tenantId)
    {
        return Ok(new List<Product>());
    }

    [HttpGet("{id:int}")]
    public ActionResult<Product> Get(
        int id,
        [FromQuery(Name = "include_archived")] bool includeArchived = false)
    {
        return new Product { Id = id, Sku = "" };
    }

    [HttpGet("by-status")]
    public ActionResult<List<Product>> ByStatus([FromQuery] ProductStatus status)
    {
        return new List<Product>();
    }
}

public sealed class ProductQuery
{
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
    public string? Search { get; set; }
}

public enum ProductStatus
{
    Draft,
    Active,
    Archived,
}

public sealed class Product
{
    public int Id { get; set; }

    [MaxLength(50)]
    public required string Sku { get; set; }

    [MaxLength(10)]
    public string[] Tags { get; set; } = [];

    public ProductStatus Status { get; set; }

    public Money Price { get; set; }

    public string? DisplayName { get; set; }
}

public readonly record struct Money(decimal Amount, string Currency);
```

`Controllers/ReportsController.cs`:

```csharp
using Asp.Versioning;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// B14: URL-segment versioning fans [ApiVersion] out to one route per version.
// B32: [MapToApiVersion] pins an action to a subset — no route is invented for
// versions it does not declare.
[ApiController]
[ApiVersion("1.0")]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public class ReportsController : ControllerBase
{
    // Reachable as /api/v1.0/Reports and /api/v2.0/Reports.
    [HttpGet]
    public ActionResult<List<Report>> List()
    {
        return new List<Report>();
    }

    // Reachable only as /api/v2.0/Reports/summary.
    [HttpGet("summary")]
    [MapToApiVersion("2.0")]
    public ActionResult<Report> Summary()
    {
        return new Report { Id = 1, Title = "" };
    }
}

public sealed class Report
{
    public int Id { get; set; }
    public required string Title { get; set; }
}
```

`Controllers/ShapesController.cs`:

```csharp
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// K2/K3/K8: [JsonPolymorphic]/[JsonDerivedType] → oneOf + custom discriminator,
// referenced through the base type. M19: an oauth2 scheme must be emitted with
// a `flows` object to be 3.1-valid.
[ApiController]
[Route("api/shapes")]
[Authorize(AuthenticationSchemes = "OAuth2")]
public class ShapesController : ControllerBase
{
    [HttpGet("{id:guid}")]
    public ActionResult<Shape> Get(Guid id)
    {
        Shape shape = new Circle { Id = id, Radius = 1 };
        return shape;
    }

    [HttpPost]
    public ActionResult<Shape> Create([FromBody] Shape shape)
    {
        return shape;
    }
}

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(Circle), "circle")]
[JsonDerivedType(typeof(Rectangle), "rectangle")]
public abstract class Shape
{
    public Guid Id { get; set; }
}

public sealed class Circle : Shape
{
    public double Radius { get; set; }
}

public sealed class Rectangle : Shape
{
    public double Width { get; set; }
    public double Height { get; set; }
}
```

`Versioning/AspVersioningStubs.cs`:

```csharp
// Stand-ins for the Asp.Versioning.Mvc attributes so the fixture restores with
// no NuGet dependency. The analyzer matches attributes by short name (see
// AttributeReader), exactly as the in-memory analyzer tests do, so these stubs
// exercise the same code path as the real package.
namespace Asp.Versioning;

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public sealed class ApiVersionAttribute : Attribute
{
    public ApiVersionAttribute(string version) => Version = version;

    public string Version { get; }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class MapToApiVersionAttribute : Attribute
{
    public MapToApiVersionAttribute(string version) => Version = version;

    public string Version { get; }
}
```

- [ ] **Step 3: Derlenebilirlik ve restore**

Run: `cd /c/dev/ASTronaut && dotnet build fixtures/dotnet/controllers-features/ControllersFeatures.csproj -nologo -v q; echo "exit=$?"`
Expected: `exit=0` (uyarı satırları olabilir, `error CS…` satırı olmamalı). Bu adım `bin/`/`obj/` üretir; ikisi de gitignore'da. Ardından `pnpm restore:fixtures`.

- [ ] **Step 4: Golden'ı üret ve incele**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e`
Expected: PASS, `controllers-features` için yeni snapshot yazılır. `fixtures/dotnet/controllers-features/expected.openapi.yaml` içinde doğrula:
- Path sırası dosya sırasıyla: önce `/api/products…`, sonra `/api/v1.0/Reports`, `/api/v2.0/Reports`, `/api/v2.0/Reports/summary` (**`/api/v1.0/Reports/summary` yok** — B32), sonra `/api/shapes…`.
- `GET /api/products`: `X-Tenant-Id` header parametresi; `[AsParameters]`'tan gelen ayrı query parametreleri (`Page`/`PageSize`/`Search` adlarının ham mı, snake_case mi çıktığını not et — hangisi olursa olsun golden'a girer, davranış Task 13 raporunda belirtilir); 200 yanıtı `array` of `$ref Product` (G36).
- `GET /api/products/{id}`: `include_archived` query (E3).
- `GET /api/products/by-status`: `status` query, `type: string`, `enum: [Draft, Active, Archived]` (J2).
- `components.schemas.Product`: `sku` → `maxLength: 50`; `tags` → `type: array`, `maxItems: 10`; `display_name` → `type: [string, null]`; `price` → `$ref Money`; `Money` → `amount`, `currency`.
- `Shape`: `oneOf` `[Circle, Rectangle]`, `discriminator.propertyName: kind`, `mapping` `circle`/`rectangle`.
- `securitySchemes.oauth2`: `type: oauth2`, `flows: {}`; `/api/shapes*` operasyonlarında `security: [{ oauth2: [] }]`.
Sapmaları düzeltme; Task 13 bulgu listesine yaz.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/ASTronaut
git add fixtures/dotnet/controllers-features
git commit -m "test(e2e): add controllers-features fixture covering Grup 1 fixes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Fixture `solution-multi-project` (.sln, proje-arası DTO dedup)

**Files:**
- Create: `fixtures/dotnet/solution-multi-project/MultiProject.sln` (`dotnet new sln` ile)
- Create: `fixtures/dotnet/solution-multi-project/Contracts/Contracts.csproj`, `Contracts/Customer.cs`
- Create: `fixtures/dotnet/solution-multi-project/Orders.Api/Orders.Api.csproj`, `Orders.Api/Program.cs`, `Orders.Api/Controllers/OrdersController.cs`
- Create: `fixtures/dotnet/solution-multi-project/Billing.Api/Billing.Api.csproj`, `Billing.Api/Program.cs`, `Billing.Api/Controllers/InvoicesController.cs`
- Create (üretilir): `fixtures/dotnet/solution-multi-project/expected.openapi.yaml`

**Interfaces:**
- Consumes: Task 3 (proje sırası), Task 5.
- Produces: `Contracts/Contracts.csproj` → Task 11'deki "0 routes" senaryosu bu dosyayı kullanır.

- [ ] **Step 1: Projeler**

`Contracts/Contracts.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
</Project>
```

`Contracts/Customer.cs`:

```csharp
namespace Contracts;

// Shared DTO returned by both API projects: it must be hoisted into
// components/schemas exactly once (R2/R6), not once per compilation.
public sealed class Customer
{
    public int Id { get; set; }
    public required string Email { get; set; }
}
```

`Orders.Api/Orders.Api.csproj` (Billing.Api için aynı içerik, dosya adı `Billing.Api.csproj`):

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contracts\Contracts.csproj" />
  </ItemGroup>
</Project>
```

`Orders.Api/Program.cs` ve `Billing.Api/Program.cs` (aynı içerik):

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

`Orders.Api/Controllers/OrdersController.cs`:

```csharp
using Contracts;
using Microsoft.AspNetCore.Mvc;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public ActionResult<Order> Get(int id)
    {
        return new Order { Id = id, Customer = new Customer { Id = 1, Email = "" } };
    }
}

public sealed class Order
{
    public int Id { get; set; }
    public required Customer Customer { get; set; }
    public decimal Total { get; set; }
}
```

`Billing.Api/Controllers/InvoicesController.cs`:

```csharp
using Contracts;
using Microsoft.AspNetCore.Mvc;

namespace Billing.Api.Controllers;

[ApiController]
[Route("api/invoices")]
public class InvoicesController : ControllerBase
{
    [HttpGet("{id:int}")]
    public ActionResult<Invoice> Get(int id)
    {
        return new Invoice { Id = id, Customer = new Customer { Id = 1, Email = "" } };
    }
}

public sealed class Invoice
{
    public int Id { get; set; }
    public required Customer Customer { get; set; }
    public decimal Amount { get; set; }
}
```

- [ ] **Step 2: Solution dosyasını toolchain ile üret**

```bash
cd /c/dev/ASTronaut/fixtures/dotnet/solution-multi-project
dotnet new sln -n MultiProject
dotnet sln MultiProject.sln add Contracts/Contracts.csproj Orders.Api/Orders.Api.csproj Billing.Api/Billing.Api.csproj
cat MultiProject.sln
```
Expected: klasik `.sln` (ilk satır `Microsoft Visual Studio Solution File, Format Version 12.00`), üç `Project(...)` girdisi. `dotnet new sln` bir `.slnx` üretirse (`--format` varsayılanı değişmişse) `dotnet new sln -n MultiProject --format sln` ile tekrar üret; bu fixture'ın amacı klasik `.sln` yolunu (`OpenSolutionAsync`) test etmektir.

- [ ] **Step 3: Derle ve restore et**

Run: `cd /c/dev/ASTronaut && dotnet build fixtures/dotnet/solution-multi-project/MultiProject.sln -nologo -v q; echo "exit=$?"; pnpm restore:fixtures`
Expected: `exit=0`, `error CS…` satırı yok.

- [ ] **Step 4: Golden'ı üret ve incele**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e`
Expected: PASS, `solution-multi-project` snapshot'ı yazılır. Doğrula:
- `info.title: MultiProject`, `version: 0.0.0` (solution başlığı `.sln` adından).
- Path sırası proje yolu sırasıyla: `/api/invoices/{id}` (Billing.Api) önce, `/api/orders/{id}` sonra.
- `components.schemas` içinde **tek** `Customer` (kopya `ContractsCustomer` benzeri ad yok); `Invoice.customer` ve `Order.customer` aynı `$ref: '#/components/schemas/Customer'`.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/ASTronaut
git add fixtures/dotnet/solution-multi-project
git commit -m "test(e2e): add solution-multi-project fixture (.sln, cross-project DTO dedup)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Fixture `diagnostics-open-generic` (W004)

**Files:**
- Create: `fixtures/dotnet/diagnostics-open-generic/DiagnosticsOpenGeneric.csproj`, `Program.cs`, `Controllers/GenericController.cs`, `Controllers/ItemsController.cs`
- Create (üretilir): `fixtures/dotnet/diagnostics-open-generic/expected.openapi.yaml`

**Interfaces:**
- Consumes: Task 5.
- Produces: Task 11 senaryo 7-8 bu fixture'ı ve golden'ını kullanır.

- [ ] **Step 1: Dosyalar**

`DiagnosticsOpenGeneric.csproj` — Task 6'daki csproj ile aynı içerik.

`Program.cs` — Task 7'deki `Program.cs` ile aynı içerik.

`Controllers/GenericController.cs`:

```csharp
using Microsoft.AspNetCore.Mvc;

namespace DiagnosticsOpenGeneric.Controllers;

// An OPEN generic controller has an unbound T: no route can be emitted for it.
// The analyzer must skip it with a W004 warning instead of dropping it silently
// (B13). The concrete ItemsController next to it must be unaffected.
[ApiController]
[Route("api/generic")]
public class GenericController<T> : ControllerBase
    where T : class, new()
{
    [HttpGet]
    public ActionResult<T> Get()
    {
        return new T();
    }
}
```

`Controllers/ItemsController.cs`:

```csharp
using Microsoft.AspNetCore.Mvc;

namespace DiagnosticsOpenGeneric.Controllers;

[ApiController]
[Route("api/items")]
public class ItemsController : ControllerBase
{
    [HttpGet]
    public ActionResult<List<Item>> List()
    {
        return new List<Item>();
    }
}

public sealed class Item
{
    public int Id { get; set; }
    public required string Name { get; set; }
}
```

- [ ] **Step 2: Derle, restore et, CLI ile W004'ü gör**

```bash
cd /c/dev/ASTronaut
dotnet build fixtures/dotnet/diagnostics-open-generic/DiagnosticsOpenGeneric.csproj -nologo -v q && pnpm restore:fixtures
node apps/cli/dist/bin.js analyze fixtures/dotnet/diagnostics-open-generic -o "$TEMP/open-generic.yaml"; echo "exit=$?"
```
Expected: stderr'de `…/Controllers/GenericController.cs:<satır> W004 Open generic controller 'GenericController' was skipped; …`, ardından `Wrote 1 route(s)`, `exit=0`.

- [ ] **Step 3: Golden'ı üret ve incele**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e`
Expected: PASS; golden'da yalnız `/api/items` ve `Item` şeması var; `generic` geçmiyor.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/ASTronaut
git add fixtures/dotnet/diagnostics-open-generic
git commit -m "test(e2e): add diagnostics-open-generic fixture (W004)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Fixture `diagnostics-multi-csproj` (W007)

**Files:**
- Create: `fixtures/dotnet/diagnostics-multi-csproj/Alpha/Alpha.csproj`, `Alpha/Program.cs`, `Alpha/Controllers/AlphaController.cs`
- Create: `fixtures/dotnet/diagnostics-multi-csproj/Beta/Beta.csproj`, `Beta/Program.cs`, `Beta/Controllers/BetaController.cs`
- Create (üretilir): `fixtures/dotnet/diagnostics-multi-csproj/expected.openapi.yaml`

**Interfaces:**
- Consumes: Task 5.
- Produces: Task 11 senaryo 9 bu fixture'ı ve golden'ını kullanır.

- [ ] **Step 1: Dosyalar**

`Alpha/Alpha.csproj` ve `Beta/Beta.csproj` — Task 6'daki csproj ile aynı içerik. `Alpha/Program.cs` ve `Beta/Program.cs` — Task 7'deki `Program.cs` ile aynı içerik. Kök dizinde `.sln` **yok**: hem CLI (`detect.ts`, `localeCompare`) hem analyzer (`ProjectLoader`, `Ordinal`) iki adayı görür ve `Alpha`'yı seçer — adlar iki sıralamada da aynı sonucu verecek şekilde seçildi (A14).

`Alpha/Controllers/AlphaController.cs`:

```csharp
using Microsoft.AspNetCore.Mvc;

namespace Alpha.Controllers;

[ApiController]
[Route("api/alpha")]
public class AlphaController : ControllerBase
{
    [HttpGet]
    public ActionResult<AlphaItem> Get()
    {
        return new AlphaItem { Id = 1 };
    }
}

public sealed class AlphaItem
{
    public int Id { get; set; }
}
```

`Beta/Controllers/BetaController.cs`:

```csharp
using Microsoft.AspNetCore.Mvc;

namespace Beta.Controllers;

[ApiController]
[Route("api/beta")]
public class BetaController : ControllerBase
{
    [HttpGet]
    public ActionResult<BetaItem> Get()
    {
        return new BetaItem { Id = 1 };
    }
}

public sealed class BetaItem
{
    public int Id { get; set; }
}
```

- [ ] **Step 2: Derle, restore et, CLI ile W007'yi gör**

```bash
cd /c/dev/ASTronaut
dotnet build fixtures/dotnet/diagnostics-multi-csproj/Alpha/Alpha.csproj -nologo -v q && dotnet build fixtures/dotnet/diagnostics-multi-csproj/Beta/Beta.csproj -nologo -v q && pnpm restore:fixtures
node apps/cli/dist/bin.js analyze fixtures/dotnet/diagnostics-multi-csproj -o "$TEMP/multi.yaml"; echo "exit=$?"
```
Expected: stderr'de `Multiple .csproj files found; using …Alpha…Alpha.csproj`, `Detected: aspnet project (…Alpha.csproj)`, analyzer'dan `… W007 Multiple project (.csproj) files found (2); selected deterministically (Ordinal-first): …Alpha/Alpha.csproj`, `Wrote 1 route(s)`, `exit=0`.

- [ ] **Step 3: Golden'ı üret ve incele**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e`
Expected: PASS; golden: `title: Alpha`, yalnız `/api/alpha`, yalnız `AlphaItem`.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/ASTronaut
git add fixtures/dotnet/diagnostics-multi-csproj
git commit -m "test(e2e): add diagnostics-multi-csproj fixture (W007)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Fixture `diagnostics-load-failure` (E001 → exit 1)

**Files:**
- Create: `fixtures/dotnet/diagnostics-load-failure/Broken.sln`
- Modify: `apps/cli/test/pipeline.e2e.test.ts` (`FAILURE_FIXTURES`)

**Interfaces:**
- Consumes: Task 5 (`FAILURE_FIXTURES`).
- Produces: Task 11 senaryo 10 bu fixture'ı kullanır.

- [ ] **Step 1: Kırık solution**

`fixtures/dotnet/diagnostics-load-failure/Broken.sln` (elle; `dotnet sln add` var olmayan projeyi reddeder):

```
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Missing", "Missing\Missing.csproj", "{6D3F0C11-6A2E-4C1B-9D2E-000000000001}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
		Release|Any CPU = Release|Any CPU
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{6D3F0C11-6A2E-4C1B-9D2E-000000000001}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
		{6D3F0C11-6A2E-4C1B-9D2E-000000000001}.Debug|Any CPU.Build.0 = Debug|Any CPU
		{6D3F0C11-6A2E-4C1B-9D2E-000000000001}.Release|Any CPU.ActiveCfg = Release|Any CPU
		{6D3F0C11-6A2E-4C1B-9D2E-000000000001}.Release|Any CPU.Build.0 = Release|Any CPU
	EndGlobalSection
EndGlobal
```

Dizinde başka dosya yok: `.csproj` bulunmadığı için analyzer'ın fallback taraması da boş döner.

- [ ] **Step 2: Sözleşmeyi CLI ile doğrula**

Run: `cd /c/dev/ASTronaut && node apps/cli/dist/bin.js analyze fixtures/dotnet/diagnostics-load-failure > "$TEMP/lf.out"; echo "exit=$?"; wc -c < "$TEMP/lf.out"`
Expected: `exit=1`, stdout 0 byte; stderr'de analyzer'dan gelen `Analyzer exited with code 1` ve stderr kuyruğu (O9 — bkz. spec §2). Eğer exit 0 görürsen (analyzer boş bir belge üretti demektir) bu bir bulgudur: Task 13 raporuna yaz ve fixture'ı bu haliyle **bırakma** — alternatif tetikleyici olarak `Broken.sln`'i silip yerine geçersiz XML içeren tek bir `Broken.csproj` (`<Project Sdk="Microsoft.NET.Sdk.Web">` açılışı olup kapanışı olmayan) koy ve komutu tekrar çalıştır; exit 1 alınan varyantı kullan.

- [ ] **Step 3: Golden testinden dışla**

`apps/cli/test/pipeline.e2e.test.ts`:

```ts
const FAILURE_FIXTURES = new Set<string>([]);
```
→
```ts
const FAILURE_FIXTURES = new Set<string>(["diagnostics-load-failure"]);
```

- [ ] **Step 4: e2e yeşil, golden üretilmedi**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e && ls fixtures/dotnet/diagnostics-load-failure`
Expected: PASS; dizinde yalnız `Broken.sln`.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/ASTronaut && pnpm lint
git add fixtures/dotnet/diagnostics-load-failure apps/cli/test/pipeline.e2e.test.ts
git commit -m "test(e2e): add diagnostics-load-failure fixture (E001 exits 1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: CLI sözleşme testleri

**Files:**
- Create: `apps/cli/test/cli.e2e.test.ts`

**Interfaces:**
- Consumes: `runCli`, `fixturePath`, `goldenPath`, `normalizeEol`, `repoRoot` (Task 5); golden'lar (Task 5, 8, 9); `Contracts.csproj` (Task 7); `diagnostics-load-failure` (Task 10); `toYaml`, `OpenApiDocument` (`@astronaut/generator`).
- Produces: —

- [ ] **Step 1: Testi yaz**

`apps/cli/test/cli.e2e.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiDocument } from "@astronaut/generator";
import { toYaml } from "@astronaut/generator";
import { resolveDotnetAnalyzer } from "@astronaut/parser-bridge";
import { describe, expect, it } from "vitest";
import { fixturePath, goldenPath, normalizeEol, repoRoot, runCli } from "./support/runCli.js";

// The CLI contract as a user experiences it: exit codes, what lands on stdout
// versus stderr, and the options — running the real apps/cli/dist/bin.js.
// Exit codes: 0 success · 1 user/analysis error · 2 analyzer binary missing.

let analyzerBuilt = false;
try {
  analyzerBuilt = existsSync(resolveDotnetAnalyzer({ repoRootHint: repoRoot }));
} catch {
  analyzerBuilt = false;
}

const basic = fixturePath("controllers-basic");

function golden(fixture: string): string {
  return normalizeEol(readFileSync(goldenPath(fixture), "utf8"));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astronaut-cli-"));
}

describe.skipIf(!analyzerBuilt)("cli: analyze contract", () => {
  if (!analyzerBuilt) {
    it("skipped — run `pnpm build:analyzers` to enable", () => {});
    return;
  }

  it("writes YAML to -o (creating parent dirs, spaces allowed) and keeps stdout empty", async () => {
    const out = join(tempDir(), "nested dir", "spec.yaml");
    const res = await runCli(["analyze", basic, "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe("");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("controllers-basic"));
  });

  it("streams the same YAML to stdout when -o is omitted, with nothing else on stdout", async () => {
    const res = await runCli(["analyze", basic]);
    expect(res.code, res.stderr).toBe(0);
    expect(normalizeEol(res.stdout)).toBe(golden("controllers-basic"));
  });

  it("--json emits the same document as JSON", async () => {
    const res = await runCli(["analyze", basic, "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(res.stdout) as OpenApiDocument;
    expect(doc.openapi).toBe("3.1.0");
    // Re-serialising the parsed JSON must reproduce the YAML golden exactly.
    expect(toYaml(doc)).toBe(golden("controllers-basic"));
  });

  it("--json -o writes JSON to the file", async () => {
    const out = join(tempDir(), "spec.json");
    const res = await runCli(["analyze", basic, "--json", "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(out, "utf8")) as OpenApiDocument;
    expect(toYaml(doc)).toBe(golden("controllers-basic"));
  });

  it("--title and --version-tag override the csproj-derived info", async () => {
    const res = await runCli([
      "analyze",
      basic,
      "--json",
      "--title",
      "Custom API",
      "--version-tag",
      "9.9.9",
    ]);
    expect(res.code, res.stderr).toBe(0);
    const doc = JSON.parse(res.stdout) as OpenApiDocument;
    expect(doc.info).toEqual({ title: "Custom API", version: "9.9.9" });
  });

  it("exits 1 with a clear message when the path holds no project", async () => {
    const res = await runCli(["analyze", join(repoRoot, "does-not-exist")]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No supported project detected");
  });

  it("exits 2 when the analyzer binary cannot be found", async () => {
    const res = await runCli(["analyze", basic], {
      env: { ASTRONAUT_DOTNET_ANALYZER: join(tempDir(), "missing", "AsTronaut.Analyzer.dll") },
    });
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Analyzer binary not found");
  });

  it("exits 1 when the project yields no routes", async () => {
    const classlib = fixturePath("solution-multi-project", "Contracts", "Contracts.csproj");
    const res = await runCli(["analyze", classlib]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("0 routes");
  });

  it("reports W004 for a skipped open-generic controller and still succeeds", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli(["analyze", fixturePath("diagnostics-open-generic"), "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("W004");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("diagnostics-open-generic"));
  });

  it("--strict passes when only warnings are reported", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli([
      "analyze",
      fixturePath("diagnostics-open-generic"),
      "--strict",
      "-o",
      out,
    ]);
    expect(res.code, res.stderr).toBe(0);
  });

  it("picks the first project deterministically (W007) when a directory holds several", async () => {
    const out = join(tempDir(), "spec.yaml");
    const res = await runCli(["analyze", fixturePath("diagnostics-multi-csproj"), "-o", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("Multiple .csproj files found");
    expect(res.stderr).toContain("W007");
    expect(normalizeEol(readFileSync(out, "utf8"))).toBe(golden("diagnostics-multi-csproj"));
  });

  it("exits 1 and emits no document when the solution cannot be loaded", async () => {
    const res = await runCli(["analyze", fixturePath("diagnostics-load-failure")]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Koştur**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e`
Expected: iki dosya, hepsi PASS (`cli.e2e`: 12 test). Bir senaryo düşerse önce beklentiyi değil gerçek çıktıyı oku: `res.stderr` assertion mesajında görünür. Hata gerçek bir CLI kusuruysa (ör. `--json -o` YAML yazıyorsa) testi gevşetme; Task 13 raporuna bulgu olarak yaz ve testi `it.skip` + gerekçe yorumu ile bırak.

- [ ] **Step 3: Süre kontrolü**

Run: `cd /c/dev/ASTronaut && pnpm test:e2e 2>&1 | grep -E "Duration|Tests "`
Expected: `Duration` ≈ 60 sn veya altı. Üzerindeyse raporla; hedef sert bir kapı değil.

- [ ] **Step 4: Lint + commit**

```bash
cd /c/dev/ASTronaut && pnpm lint:fix && pnpm lint
git add apps/cli/test/cli.e2e.test.ts
git commit -m "test(e2e): add CLI contract suite (exit codes, stdout purity, options)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: CI (Linux + Windows) ve dokümantasyon

**Files:**
- Modify: `.github/workflows/ci.yml` (e2e job)
- Create: `fixtures/dotnet/README.md`
- Modify: `README.md` (Development bölümü + CI cümlesi)
- Modify: `docs/test-scenarios.md` ("Test seviyeleri", §T, Q7, yeni "E2E fixture kapsamı" tablosu)

**Interfaces:**
- Consumes: `pnpm restore:fixtures` (Task 4), fixture adları (Task 6-10).
- Produces: —

- [ ] **Step 1: e2e job'ını matrise al ve restore script'ini kullan**

`.github/workflows/ci.yml` içindeki `e2e:` job'ının tamamını şununla değiştir:

```yaml
  e2e:
    name: End-to-end (analyzer → OpenAPI 3.1, ${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      # Development happens on Windows, CI historically only on Linux; goldens
      # must be byte-identical on both.
      matrix:
        os: [ubuntu-latest, windows-latest]
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 8.0.x

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm build:analyzers
      - run: pnpm build

      # Restore the fixture projects so MSBuildWorkspace can load them on a fresh
      # checkout (obj/ is gitignored).
      - run: pnpm restore:fixtures

      - run: pnpm test:e2e
```

- [ ] **Step 2: Fixture README'si**

`fixtures/dotnet/README.md`:

```markdown
# E2E fixtures

Her alt dizin gerçek bir ASP.NET Core projesi (veya `.sln`); `pnpm test:e2e` bunları
analyzer → IR → generator hattından geçirir ve üç kapıdan kontrol eder:

1. **Golden** — `expected.openapi.yaml` ile byte-byte eşleşme.
2. **OpenAPI 3.1 meta-şema** geçerliliği.
3. **Invariant'lar** — `checkOpenApiInvariants` (`docs/test-scenarios.md` §T).

CLI sözleşmesi (`apps/cli/test/cli.e2e.test.ts`) aynı fixture'ları gerçek `bin.js` ile koşturur.

| Fixture | Kapsadığı senaryolar |
| --- | --- |
| `controllers-basic` | B1, B2, D1, E4, F1, G1, G2, G21, I1, I4, I5 |
| `controllers-rich` | B9, G3, G4, G6, L1–L7, L13, M1, M2, N1–N3 |
| `controllers-route-params` | B4, D2–D5, E2, E3, E8, E9 |
| `controllers-features` | E3, E12, E15, G36, I3, I29, J2, K2/K3/K8, L3b/L15, M19, B14, B32 |
| `solution-multi-project` | A3, R1, R2/R6, Q7 (proje sırası) |
| `diagnostics-open-generic` | B13 (W004), O2/O3 (`--strict` uyarıyla geçer) |
| `diagnostics-multi-csproj` | A6b (W007), A14 notu |
| `diagnostics-load-failure` | E001 → exit 1 (golden yok; yalnız CLI testi) |

## Yeni fixture eklemek

1. `fixtures/dotnet/<tür>-<konu>/` altında `net8.0` bir proje oluştur (`Microsoft.NET.Sdk.Web`;
   kütüphane için `Microsoft.NET.Sdk`). **NuGet `PackageReference` ekleme** — restore ağdan
   bağımsız kalmalı; üçüncü parti attribute'ları stub'la (bkz. `controllers-features/Versioning`),
   analyzer attribute'ları kısa adla eşler.
2. Tek konuya odaklan; her controller'ın başına hangi katalog satırlarını kanıtladığını yaz.
3. Dosya ve dizin adlarını ASCII ve büyük/küçük harf düzeni tutarlı seç: CLI (`localeCompare`)
   ile analyzer (`Ordinal`) aynı adayı seçmeli (A14).
4. `dotnet build <csproj>` ile derlendiğini gör, `pnpm restore:fixtures` çalıştır.
5. `pnpm test:e2e` → `expected.openapi.yaml` üretilir. **Dosyayı oku**: her beklenen satırı
   (path, parametre, şema, constraint) kontrol et. Beklenmeyen çıktı analyzer bulgusudur;
   golden'ı "düzeltme", bulguyu PR'da raporla.
6. Çıktı üretmemesi gereken bir fixture'ı `apps/cli/test/pipeline.e2e.test.ts` içindeki
   `FAILURE_FIXTURES` setine ekle ve sözleşmesini `cli.e2e.test.ts`'e yaz.

## Golden güncelleme

Analyzer/generator davranışını bilerek değiştirdiysen:

```bash
pnpm test:e2e -u
git diff fixtures/   # her satırı gözden geçir; PR açıklamasında değişikliği gerekçelendir
```

`CI` ortam değişkeni set olduğunda vitest yeni snapshot yazmaz; golden'lar commit edilmek zorundadır.
```

- [ ] **Step 3: README.md**

`README.md` › Development kod bloğunu şununla değiştir:

```bash
pnpm install
pnpm build:analyzers          # builds the .NET analyzer (bash; use scripts/build-analyzers.ps1 on pure Windows)
pnpm build                    # builds TS packages + CLI
pnpm test                     # vitest unit + snapshot suite (incl. the IR drift-check)

# .NET analyzer unit tests (in-memory Roslyn, no MSBuild):
dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests

# End-to-end: real fixture projects through the analyzer, checked against committed
# goldens (fixtures/dotnet/*/expected.openapi.yaml), the OpenAPI 3.1 meta-schema and
# the §T invariants; plus the CLI contract (exit codes, stdout/stderr, options).
pnpm restore:fixtures         # once per checkout (scripts/restore-fixtures.ps1 on pure Windows)
pnpm test:e2e
pnpm test:e2e -u              # regenerate goldens after an intended output change — review the diff

# Try it out against a checked-in fixture:
node apps/cli/dist/bin.js analyze fixtures/dotnet/controllers-rich -o out.yaml
```

ve CI cümlesini şununla değiştir:

```markdown
CI (`.github/workflows/ci.yml`) runs lint + build + vitest and the .NET tests on every push and
pull request, and the end-to-end suite on both Ubuntu and Windows. See `fixtures/dotnet/README.md`
for how fixtures and goldens work.
```

- [ ] **Step 4: docs/test-scenarios.md**

(a) "Test seviyeleri" 2. maddeyi şununla değiştir:

```markdown
2. **E2E fixture** (`pnpm test:e2e`) — checked-in fixture'lar: gerçek C# → analyzer → IR → OpenAPI;
   fixture başına **golden** (`expected.openapi.yaml`, byte-byte) + 3.1 meta-şema + §T invariant'ları
   (`checkOpenApiInvariants`); ayrıca gerçek CLI binary'si üzerinden exit kodu / stdout / opsiyon
   sözleşmesi (`cli.e2e.test.ts`). Fixture → senaryo eşlemesi: `fixtures/dotnet/README.md`.
```

(b) §T listesinin üstündeki cümleyi şununla değiştir:

```markdown
Her canlı testte çıktı üzerinde otomatik kontrol edilmesi gerekenler — ilk madde e2e'de
`@seriousme/openapi-schema-validator`, kalanlar `packages/generator/src/invariants.ts`
(`checkOpenApiInvariants`) ile **otomatik** kontrol edilir; canlı test aynı modülü kullanır:
```

(c) Q7 satırını şununla değiştir:

```markdown
| Q7 | Determinizm | tek proje: route sırası = dosya yolu (Ordinal) sırası, dosya içinde kaynak sırası; `.sln`: projeler dosya yoluna göre sıralanır → çıktı OS'ten bağımsız (golden e2e bunu doğrular) | ✅ |
```

(d) "Test-boşluğu notu" alt bölümünün sonuna ekle:

```markdown

### E2E fixture kapsamı

Grup 1 düzeltmeleri artık gerçek MSBuild derlemesi üzerinden golden e2e ile de korunuyor:
`controllers-features` (E3, E12, E15, G36, I3, I29, J2, K2/K3/K8, L3b/L15, M19, B14, B32),
`solution-multi-project` (R2/R6, Q7), `diagnostics-open-generic` (W004), `diagnostics-multi-csproj`
(W007), `diagnostics-load-failure` (E001 → exit 1). Tam tablo: `fixtures/dotnet/README.md`.
```

- [ ] **Step 5: Lint (YAML/MD biome dışında; `pnpm lint` yine koşsun) ve commit**

```bash
cd /c/dev/ASTronaut && pnpm lint
git add .github/workflows/ci.yml fixtures/dotnet/README.md README.md docs/test-scenarios.md
git commit -m "ci: run e2e on ubuntu and windows; document fixtures and goldens" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Uçtan uca doğrulama ve teslim

**Files:**
- Değişiklik yok (yalnız doğrulama ve rapor); gerekirse `global.json` (aşağıdaki koşulda).

**Interfaces:**
- Consumes: tüm önceki görevler.
- Produces: PR'a hazır branch; kullanıcıya rapor.

- [ ] **Step 1: Temiz durumdan tam doğrulama**

```bash
cd /c/dev/ASTronaut
pnpm lint && pnpm build:analyzers && pnpm build && pnpm test
dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests/AsTronaut.Analyzer.Tests.csproj -c Release
pnpm restore:fixtures && pnpm test:e2e
git status --porcelain
```
Expected: lint temiz; unit 69 test (51 + 18); .NET 73; e2e 2 dosya PASS (pipeline: 2 + 7 fixture, cli: 12); `git status` boş (golden'lar dahil her şey commit'li, `obj/`/`bin/` gitignore'da).

- [ ] **Step 2: Windows PowerShell yolu**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-fixtures.ps1` ve ardından `pnpm test:e2e`
Expected: restore her fixture için exit 0; e2e yeşil.

- [ ] **Step 3: Kullanıcıya rapor ve push/PR izni**

Raporda: (1) ne değişti (görev başına bir satır), (2) çalıştırılan komutlar ve gerçek sayılar, (3) golden incelemesinde görülen **bulgular** (Task 6-10'da not edilenler; hiçbiri düzeltilmedi), (4) bilinen sınırlar (O9 sözleşmesi pinlenmedi, `--timeout` yok), (5) kasten dokunulmayanlar. Ardından push + PR için onay iste (politika: commit serbest, push/PR öncesi sor).

- [ ] **Step 4 (onay sonrası): Push ve PR**

```bash
cd /c/dev/ASTronaut
git push -u origin feat/e2e-golden-suite
gh pr create --title "test: golden E2E suite with invariants, CLI contract and Windows CI" --body-file - <<'EOF'
## Summary
- `checkOpenApiInvariants` in `@astronaut/generator`: unique operationIds/params, resolvable $refs, path-param ↔ template match, defined security schemes, 3.1-style nullable, no empty schemas (unit-tested).
- Golden e2e: every fixture's emitted OpenAPI is compared byte-for-byte with `fixtures/dotnet/<name>/expected.openapi.yaml`, then validated against the 3.1 meta-schema and the invariants.
- CLI contract e2e over the real `bin.js`: exit codes 0/1/2, stdout purity, `-o`, `--json`, `--strict`, `--title`, `--version-tag`, W004/W007 diagnostics, load failure.
- 5 new fixtures: `controllers-features` (Grup 1), `solution-multi-project` (.sln, R2 dedup), `diagnostics-open-generic` (W004), `diagnostics-multi-csproj` (W007), `diagnostics-load-failure` (E001).
- Analyzer: syntax trees and solution projects are walked in Ordinal path order (Q7) so goldens are OS-independent.
- CI: e2e job now runs on ubuntu-latest and windows-latest; `pnpm restore:fixtures` script.

Spec: `docs/superpowers/specs/2026-09-22-e2e-golden-suite-design.md`

## Findings (not fixed here)
One bullet per note recorded while reviewing goldens in Tasks 6–10 (analyzer behaviour that looked
wrong or surprising); write "None" if every golden matched expectations.

## Test plan
- [ ] `pnpm lint && pnpm build && pnpm test`
- [ ] `dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests -c Release`
- [ ] `pnpm restore:fixtures && pnpm test:e2e` (local, Windows)
- [ ] CI green on ubuntu + windows

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 5 (onay sonrası): CI'ı izle**

Run: `gh run watch` (veya `gh pr checks --watch`).
Expected: `node`, `dotnet`, `e2e (ubuntu-latest)`, `e2e (windows-latest)` yeşil. Windows job'ı MSBuild yükleme hatasıyla (`Could not load file or assembly 'Microsoft.Build…'` / SDK sürüm uyuşmazlığı) düşerse kök neden runner'ın varsayılan SDK'sıdır: repo köküne `global.json` ekle —

```json
{
  "sdk": {
    "version": "8.0.100",
    "rollForward": "latestFeature"
  }
}
```

— `pnpm build:analyzers && pnpm test:e2e` ile yerelde doğrula, `chore: pin .NET SDK 8 via global.json for MSBuildLocator` mesajıyla commit'le, push et, CI'ı tekrar izle. Golden bir OS'te farklıysa (`toMatchFileSnapshot` diff'i) bu bir determinizm bulgusudur: diff'i rapora al, Task 3'ün kapsamadığı sıralama kaynağını (`SharedSchemas` ekleme sırası, `Dictionary` sırası vb.) kök neden olarak belirle; golden'ı "iki sürüm" tutarak çözme.
