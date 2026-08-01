import { defineConfig } from "vitest/config";

// End-to-end suite: builds real ParseResult from the .NET analyzer over the
// checked-in fixture projects, then validates the emitted OpenAPI. Slow (MSBuild
// per fixture) and requires the analyzer to be built (`pnpm build:analyzers`),
// so it's kept out of the default unit run.
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.e2e.test.ts", "packages/*/test/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
