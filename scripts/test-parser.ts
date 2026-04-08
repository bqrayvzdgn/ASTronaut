/**
 * Standalone parser test script.
 * Usage: npx ts-node scripts/test-parser.ts <repoPath> [express|aspnet|gin]
 *
 * Example:
 *   npx ts-node scripts/test-parser.ts ../my-express-app express
 */
import path from "path";
import "../src/parser/modules";
import { detectAndParse, getFrameworkModule } from "../src/parser/registry";
import { generateOpenApiSpec } from "../src/generator/openApiGenerator";

async function main() {
  const repoPath = path.resolve(process.argv[2] || ".");
  const forceFramework = process.argv[3];

  console.log(`\n📂 Repo: ${repoPath}`);

  const autodocConfig = forceFramework ? { framework: forceFramework } : null;

  if (forceFramework) {
    const mod = getFrameworkModule(forceFramework);
    if (!mod) {
      console.error(`Unknown framework: ${forceFramework}`);
      process.exit(1);
    }
    console.log(`🔍 Framework: ${mod.name} (forced)\n`);
  } else {
    console.log(`🔍 Framework: auto-detect\n`);
  }

  const parseResult = await detectAndParse(repoPath, autodocConfig);

  // Summary
  console.log(`✅ Routes found: ${parseResult.routes.length}`);
  if (parseResult.errors.length > 0) {
    console.log(`⚠️  Errors: ${parseResult.errors.length}`);
    parseResult.errors.forEach((e) => console.log(`   - ${e.file}: ${e.reason}`));
  }

  console.log("\n--- Routes ---");
  parseResult.routes.forEach((r) => {
    console.log(`  ${r.method.padEnd(7)} ${r.path}  ${r.auth ? `[${r.auth}]` : ""}`);
  });

  // Generate spec
  const spec = generateOpenApiSpec(parseResult, {
    title: path.basename(repoPath),
    version: "test",
  });

  console.log("\n--- OpenAPI Spec ---");
  console.log(spec);
}

main().catch(console.error);
