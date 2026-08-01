import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // e2e tests spawn the built .NET analyzer; they run via `pnpm test:e2e`
    // (see vitest.e2e.config.ts), not in the fast unit loop.
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/dist/**", "**/node_modules/**", "**/generated/**", "**/*.d.ts", "**/index.ts"],
      thresholds: {
        branches: 60,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
