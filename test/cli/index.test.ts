import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const CLI_PATH = path.resolve(__dirname, "../../src/cli/index.ts");
const REPO_ROOT = path.resolve(__dirname, "../..");

function runCLI(args: string = "", cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execSync(`npx ts-node ${CLI_PATH} ${args}`, {
      encoding: "utf-8",
      cwd: cwd || REPO_ROOT,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("CLI", () => {
  it("should show help with --help", () => {
    const result = runCLI("--help");
    // Help prints to stderr, exit 0 — but execSync catches both
    expect(result.stdout).toContain("ASTronaut");
    expect(result.stdout).toContain("--framework");
    expect(result.stdout).toContain("--output");
  });

  it("should show version with --version", () => {
    const result = runCLI("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/astronaut v\d+\.\d+\.\d+/);
  });

  it("should fail with nonexistent path", () => {
    const result = runCLI("/nonexistent/path/that/does/not/exist");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error");
  });

  it("should analyze the current repo and output YAML", () => {
    const result = runCLI(REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("openapi:");
    expect(result.stdout).toContain("3.0.3");
  });

  it("should output JSON with --format json", () => {
    const result = runCLI(`${REPO_ROOT} --format json`);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.openapi).toBe("3.0.3");
  });

  it("should write to file with --output", () => {
    const tmpFile = path.join(os.tmpdir(), `astronaut-test-${Date.now()}.yaml`);
    try {
      const result = runCLI(`${REPO_ROOT} --output ${tmpFile}`);
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(tmpFile)).toBe(true);
      const content = fs.readFileSync(tmpFile, "utf-8");
      expect(content).toContain("openapi:");
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it("should accept --framework flag", () => {
    const result = runCLI(`${REPO_ROOT} --framework express`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("openapi:");
  });

  it("should fail with unknown framework on empty dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astronaut-empty-"));
    try {
      const result = runCLI(tmpDir);
      expect(result.exitCode).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
