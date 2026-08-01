import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAspnetProject } from "../src/detect.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "astronaut-detect-"));
}

describe("detectAspnetProject", () => {
  it("returns null when the path does not exist", () => {
    expect(detectAspnetProject(join(tmpdir(), "does-not-exist-xyz"))).toBeNull();
  });

  it("detects a directory containing a .csproj", () => {
    const dir = makeTempDir();
    const csproj = join(dir, "Sample.csproj");
    writeFileSync(csproj, '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    const result = detectAspnetProject(dir);
    expect(result?.framework).toBe("aspnet");
    expect(result?.kind).toBe("project");
    expect(result?.path).toBe(csproj);
  });

  it("accepts a .csproj file directly", () => {
    const dir = makeTempDir();
    const csproj = join(dir, "Sample.csproj");
    writeFileSync(csproj, '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    const result = detectAspnetProject(csproj);
    expect(result?.kind).toBe("project");
    expect(result?.path).toBe(csproj);
  });

  it("accepts a .sln file directly", () => {
    const dir = makeTempDir();
    const sln = join(dir, "Sample.sln");
    writeFileSync(sln, "");
    const result = detectAspnetProject(sln);
    expect(result?.kind).toBe("solution");
    expect(result?.path).toBe(sln);
  });

  it("prefers a solution over a bare .csproj in a directory", () => {
    const dir = makeTempDir();
    const sln = join(dir, "Sample.sln");
    writeFileSync(sln, "");
    writeFileSync(join(dir, "Sample.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    const result = detectAspnetProject(dir);
    expect(result?.kind).toBe("solution");
    expect(result?.path).toBe(sln);
  });

  it("skips .csproj files under bin/ and obj/", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "Stale.csproj"), "<Project />\n");
    expect(detectAspnetProject(dir)).toBeNull();
  });

  it("returns null for a non-csproj file", () => {
    const dir = makeTempDir();
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "");
    expect(detectAspnetProject(txt)).toBeNull();
  });
});
