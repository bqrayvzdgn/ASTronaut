/**
 * Standalone parser test script.
 * Usage: npx ts-node scripts/test-parser.ts <repoPath> [express|nestjs|dotnet]
 *
 * Example:
 *   npx ts-node scripts/test-parser.ts ../my-express-app express
 */
import path from "path";
import { detectFramework } from "../src/detector/frameworkDetector";
import { generateOpenApiSpec } from "../src/generator/openApiGenerator";
import type { ParseResult } from "../src/parser/types";

async function main() {
  const repoPath = path.resolve(process.argv[2] || ".");
  const forceFramework = process.argv[3];

  console.log(`\n📂 Repo: ${repoPath}`);

  // Detect or use forced framework
  const framework = forceFramework || (await detectFramework(repoPath, null));
  console.log(`🔍 Framework: ${framework}\n`);

  // Parse
  let parseResult: ParseResult;
  switch (framework) {
    case "express": {
      const { parseExpressRoutes } = await import("../src/parser/expressParser");
      parseResult = await parseExpressRoutes(repoPath);
      break;
    }
    case "nestjs": {
      const { parseNestRoutes } = await import("../src/parser/nestParser");
      parseResult = parseNestRoutes(repoPath);
      break;
    }
    case "nextjs": {
      const { parseNextRoutes } = await import("../src/parser/nextParser");
      parseResult = await parseNextRoutes(repoPath);
      break;
    }
    case "aspnet-controller":
    case "aspnet-minimal":
    case "aspnet-both": {
      const { parseDotnet } = await import("../src/parser/dotnetBridge");
      parseResult = await parseDotnet(repoPath);
      break;
    }
    default:
      console.error(`Unknown framework: ${framework}`);
      process.exit(1);
  }

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
