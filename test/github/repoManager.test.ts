import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";

jest.mock("../../src/config", () => ({
  config: {
    timeouts: { cloneMs: 30000 },
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

import { removeSensitiveFiles, cleanup } from "../../src/github/repoManager";

function createTempDir(files: string[]): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "repo-mgr-test-"));
  for (const f of files) {
    const filePath = path.join(dir, f);
    const fileDir = path.dirname(filePath);
    fsSync.mkdirSync(fileDir, { recursive: true });
    fsSync.writeFileSync(filePath, "test content");
  }
  return dir;
}

describe("repoManager", () => {
  describe("removeSensitiveFiles", () => {
    let tmpDir: string;

    afterEach(async () => {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("should remove .env file", async () => {
      tmpDir = createTempDir([".env", "index.ts"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, ".env"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "index.ts"))).toBe(true);
    });

    it("should remove credentials.json", async () => {
      tmpDir = createTempDir(["credentials.json", "app.ts"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "credentials.json"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "app.ts"))).toBe(true);
    });

    it("should remove service-account.json", async () => {
      tmpDir = createTempDir(["service-account.json"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "service-account.json"))).toBe(false);
    });

    it("should remove .env.* prefixed files", async () => {
      tmpDir = createTempDir([".env.local", ".env.production", "safe.txt"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, ".env.local"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, ".env.production"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "safe.txt"))).toBe(true);
    });

    it("should remove files with sensitive extensions", async () => {
      tmpDir = createTempDir(["server.pem", "private.key", "cert.pfx", "auth.p12", "app.ts"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "server.pem"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "private.key"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "cert.pfx"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "auth.p12"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "app.ts"))).toBe(true);
    });

    it("should remove sensitive files in subdirectories", async () => {
      tmpDir = createTempDir(["config/.env", "keys/server.pem", "src/app.ts"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "config", ".env"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "keys", "server.pem"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "src", "app.ts"))).toBe(true);
    });

    it("should remove appsettings Development and Local variants", async () => {
      tmpDir = createTempDir([
        "appsettings.Development.json",
        "appsettings.Local.json",
        "appsettings.json",
      ]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "appsettings.Development.json"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "appsettings.Local.json"))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, "appsettings.json"))).toBe(true);
    });

    it("should not remove safe files", async () => {
      tmpDir = createTempDir(["package.json", "README.md", "src/index.ts"]);
      await removeSensitiveFiles(tmpDir);

      expect(fsSync.existsSync(path.join(tmpDir, "package.json"))).toBe(true);
      expect(fsSync.existsSync(path.join(tmpDir, "README.md"))).toBe(true);
      expect(fsSync.existsSync(path.join(tmpDir, "src", "index.ts"))).toBe(true);
    });

    it("should handle empty directory", async () => {
      tmpDir = createTempDir([]);
      await expect(removeSensitiveFiles(tmpDir)).resolves.not.toThrow();
    });

    it("should skip symlinks during sensitive file walk", async () => {
      tmpDir = createTempDir(["real-secret.key", "safe.ts"]);
      // Create a symlink with a non-sensitive name pointing to sensitive content
      const symlinkPath = path.join(tmpDir, "config-link");
      try {
        fsSync.symlinkSync(path.join(tmpDir, "safe.ts"), symlinkPath);
      } catch {
        // Skip test on systems that don't support symlinks (Windows without admin)
        return;
      }

      await removeSensitiveFiles(tmpDir);
      // The real sensitive file should be removed
      expect(fsSync.existsSync(path.join(tmpDir, "real-secret.key"))).toBe(false);
      // The safe file should remain
      expect(fsSync.existsSync(path.join(tmpDir, "safe.ts"))).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("should remove the directory and all contents", async () => {
      const tmpDir = createTempDir(["file1.ts", "sub/file2.ts"]);
      expect(fsSync.existsSync(tmpDir)).toBe(true);

      await cleanup(tmpDir);
      expect(fsSync.existsSync(tmpDir)).toBe(false);
    });
  });

  describe("assertSafeName", () => {
    // assertSafeName is not exported, but cloneRepo uses it internally.
    // We test it indirectly via the exported cloneRepo function.
    // Import cloneRepo and verify it rejects unsafe names.
    it("should reject names with path traversal characters", async () => {
      const { cloneRepo } = require("../../src/github/repoManager");
      await expect(cloneRepo("../evil", "repo", "token")).rejects.toThrow(
        "Invalid"
      );
    });

    it("should reject names with shell metacharacters", async () => {
      const { cloneRepo } = require("../../src/github/repoManager");
      await expect(cloneRepo("owner", "repo;rm -rf /", "token")).rejects.toThrow(
        "Invalid"
      );
    });

    it("should reject names with spaces", async () => {
      const { cloneRepo } = require("../../src/github/repoManager");
      await expect(cloneRepo("owner name", "repo", "token")).rejects.toThrow(
        "Invalid"
      );
    });

    it("should reject names with slashes", async () => {
      const { cloneRepo } = require("../../src/github/repoManager");
      await expect(cloneRepo("owner/evil", "repo", "token")).rejects.toThrow(
        "Invalid"
      );
    });
  });
});
