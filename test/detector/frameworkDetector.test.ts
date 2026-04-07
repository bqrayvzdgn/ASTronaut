import fs from "fs";
import path from "path";
import os from "os";
import {
  detectFramework,
  Framework,
} from "../../src/detector/frameworkDetector";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autodoc-test-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writePackageJson(dir: string, deps: Record<string, string>): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: deps }, null, 2)
  );
}

describe("detectFramework", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it("should detect Express from package.json dependencies", async () => {
    writePackageJson(tmpDir, { express: "^4.18.0" });

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.EXPRESS);
  });

  it("should detect NestJS from package.json dependencies", async () => {
    writePackageJson(tmpDir, {
      "@nestjs/core": "^10.0.0",
      "@nestjs/common": "^10.0.0",
    });

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.NESTJS);
  });

  it("should detect ASP.NET Controller-based from .csproj and Controllers dir", async () => {
    // Create a .csproj file referencing ASP.NET Core
    fs.writeFileSync(
      path.join(tmpDir, "MyApi.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
  </ItemGroup>
</Project>`
    );

    // Create Controllers directory
    fs.mkdirSync(path.join(tmpDir, "Controllers"));
    fs.writeFileSync(
      path.join(tmpDir, "Controllers", "WeatherController.cs"),
      `[ApiController]
[Route("api/[controller]")]
public class WeatherController : ControllerBase { }`
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.ASPNET_CONTROLLER);
  });

  it("should detect ASP.NET Minimal API from .csproj and MapGet in Program.cs", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "MyApi.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
  </ItemGroup>
</Project>`
    );

    // Create Program.cs with minimal API patterns
    fs.writeFileSync(
      path.join(tmpDir, "Program.cs"),
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/hello", () => "Hello World");
app.Run();`
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.ASPNET_MINIMAL);
  });

  it("should use .autodoc.yml config override when present", async () => {
    // Even though package.json has express, the config override should win
    writePackageJson(tmpDir, { express: "^4.18.0" });

    const result = await detectFramework(tmpDir, { framework: "nestjs" });
    expect(result).toBe(Framework.NESTJS);
  });

  it("should throw an error when no supported framework is found", async () => {
    // Empty directory — no package.json, no .csproj
    await expect(detectFramework(tmpDir)).rejects.toThrow();
  });

  it("should detect Next.js from package.json dependencies", async () => {
    writePackageJson(tmpDir, { next: "^14.0.0" });

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.NEXTJS);
  });

  it("should detect ASP.NET Both when Controllers and Minimal API patterns coexist", async () => {
    // Create .csproj with ASP.NET Core reference
    const csprojContent = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.AspNetCore.OpenApi" /></ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(tmpDir, "MyApi.csproj"), csprojContent);

    // Create Controllers directory
    fs.mkdirSync(path.join(tmpDir, "Controllers"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "Controllers", "WeatherController.cs"),
      "[ApiController] public class WeatherController {}"
    );

    // Create Program.cs with Minimal API patterns
    fs.writeFileSync(
      path.join(tmpDir, "Program.cs"),
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/hello", () => "Hello World");
app.Run();`
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe(Framework.ASPNET_BOTH);
  });

  it("should handle malformed package.json gracefully", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ invalid json }}}");
    // Should not throw; should fall through and eventually throw "no framework found"
    await expect(detectFramework(tmpDir)).rejects.toThrow();
  });
});
