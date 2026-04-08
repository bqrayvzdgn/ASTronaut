import fs from "fs";
import path from "path";
import os from "os";
import { loadAutodocConfig } from "../../src/config/autodocConfig";

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
    })),
  },
}));

function createTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodoc-config-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("autodocConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return null when no .autodoc.yml exists", async () => {
    tmpDir = createTempRepo({});
    expect(await loadAutodocConfig(tmpDir)).toBeNull();
  });

  it("should parse valid framework config", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "framework: express\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.framework).toBe("express");
  });

  it("should accept any string as framework (validated by registry)", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "framework: gin\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.framework).toBe("gin");
  });

  it("should accept aspnet as valid framework", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "framework: aspnet\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.framework).toBe("aspnet");
  });

  it("should ignore empty framework values", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "framework: \n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.framework).toBeUndefined();
  });

  it("should parse docs_output", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "docs_output: api/spec.yaml\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.docsOutput).toBe("api/spec.yaml");
  });

  it("should reject path traversal in docs_output", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "docs_output: ../../.github/workflows/evil.yml\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.docsOutput).toBeUndefined();
  });

  it("should reject absolute path in docs_output", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "docs_output: /etc/passwd\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.docsOutput).toBeUndefined();
  });

  it("should reject parent directory traversal in docs_output", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "docs_output: docs/../../../etc/passwd\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.docsOutput).toBeUndefined();
  });

  it("should return null for invalid YAML", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": ": invalid: yaml: [[[",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("should parse both framework and docs_output together", async () => {
    tmpDir = createTempRepo({
      ".autodoc.yml": "framework: express\ndocs_output: docs/api.yaml\n",
    });
    const config = await loadAutodocConfig(tmpDir);
    expect(config?.framework).toBe("express");
    expect(config?.docsOutput).toBe("docs/api.yaml");
  });
});
