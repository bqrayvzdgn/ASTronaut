import { execFile } from "child_process";
import { promisify } from "util";

// Mock child_process before importing the module under test
jest.mock("child_process", () => {
  const mockFn = jest.fn();
  return {
    execFile: mockFn,
  };
});

// Mock util.promisify to return a mock that we control
jest.mock("util", () => {
  const mockExecFileAsync = jest.fn();
  return {
    promisify: jest.fn(() => mockExecFileAsync),
    __mockExecFileAsync: mockExecFileAsync,
  };
});

// Mock config
jest.mock("../../src/config", () => ({
  config: {
    dotnetAnalyzerPath: "/mock/path/ASTronautAnalyzer.dll",
    timeouts: { parseMs: 60000 },
    logLevel: "silent",
    nodeEnv: "test",
  },
}));

// Mock logger
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mockExecFileAsync } = require("util") as { __mockExecFileAsync: jest.Mock };

import { parseDotnet } from "../../src/parser/dotnetBridge";

describe("parseDotnet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("successful CLI output", () => {
    it("should parse a valid analyzer response with routes", async () => {
      const analyzerOutput = JSON.stringify({
        routes: [
          {
            path: "/api/users",
            method: "GET",
            controller: "UsersController",
            routePrefix: "api/users",
            params: [
              {
                name: "page",
                in: "query",
                type: "integer",
                required: false,
              },
            ],
            requestBody: null,
            responses: [
              {
                status: 200,
                type: "List<User>",
                properties: [
                  { name: "id", type: "integer", required: true },
                  { name: "name", type: "string", required: false },
                  { name: "email", type: "string", required: false },
                ],
              },
            ],
            auth: "Bearer",
            middleware: [],
            description: "Gets all users",
            source: "Controllers/UsersController.cs",
          },
          {
            path: "/api/users/{id}",
            method: "POST",
            controller: "UsersController",
            routePrefix: "api/users",
            params: [
              { name: "id", in: "path", type: "integer", required: true },
            ],
            requestBody: {
              type: "CreateUserDto",
              properties: [
                { name: "name", type: "string", required: true },
                { name: "email", type: "string", required: true },
              ],
            },
            responses: [
              {
                status: 201,
                type: "User",
                properties: [
                  { name: "id", type: "integer", required: true },
                  { name: "name", type: "string", required: false },
                ],
              },
            ],
            auth: null,
            middleware: [],
            description: null,
            source: "Controllers/UsersController.cs",
          },
        ],
        errors: [],
      });

      __mockExecFileAsync.mockResolvedValue({ stdout: analyzerOutput, stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(2);
      expect(result.errors).toHaveLength(0);

      // First route
      const route1 = result.routes[0];
      expect(route1.path).toBe("/api/users");
      expect(route1.method).toBe("GET");
      expect(route1.controller).toBe("UsersController");
      expect(route1.auth).toBe("Bearer");
      expect(route1.description).toBe("Gets all users");
      expect(route1.params).toHaveLength(1);
      expect(route1.params[0]).toEqual({
        name: "page",
        in: "query",
        type: "integer",
        required: false,
      });
      expect(route1.responses[0].status).toBe(200);
      expect(route1.responses[0].type).toBe("List<User>");
      expect(route1.responses[0].properties).toHaveLength(3);

      // Second route
      const route2 = result.routes[1];
      expect(route2.method).toBe("POST");
      expect(route2.requestBody).not.toBeNull();
      expect(route2.requestBody!.type).toBe("CreateUserDto");
      expect(route2.requestBody!.properties).toHaveLength(2);
      expect(route2.responses[0].status).toBe(201);
    });

    it("should parse an empty routes response", async () => {
      const analyzerOutput = JSON.stringify({
        routes: [],
        errors: [],
      });

      __mockExecFileAsync.mockResolvedValue({ stdout: analyzerOutput, stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should normalize HTTP methods to uppercase", async () => {
      const analyzerOutput = JSON.stringify({
        routes: [
          {
            path: "/api/test",
            method: "get",
            controller: null,
            routePrefix: null,
            params: [],
            requestBody: null,
            responses: [],
            auth: null,
            middleware: [],
            description: null,
            source: "Program.cs",
          },
        ],
        errors: [],
      });

      __mockExecFileAsync.mockResolvedValue({ stdout: analyzerOutput, stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.routes[0].method).toBe("GET");
    });

    it("should handle null fields gracefully", async () => {
      const analyzerOutput = JSON.stringify({
        routes: [
          {
            path: "/api/health",
            method: "GET",
            controller: null,
            routePrefix: null,
            params: [],
            requestBody: null,
            responses: [
              {
                status: 200,
                type: null,
                properties: [],
              },
            ],
            auth: null,
            middleware: [],
            description: null,
            source: "Program.cs",
          },
        ],
        errors: [],
      });

      __mockExecFileAsync.mockResolvedValue({ stdout: analyzerOutput, stderr: "" });

      const result = await parseDotnet("/test/repo");

      const route = result.routes[0];
      expect(route.controller).toBeNull();
      expect(route.routePrefix).toBeNull();
      expect(route.requestBody).toBeNull();
      expect(route.auth).toBeNull();
      expect(route.description).toBeNull();
      expect(route.responses[0].type).toBeNull();
    });
  });

  describe("CLI stderr output (warnings)", () => {
    it("should include stderr warnings in errors array", async () => {
      const analyzerOutput = JSON.stringify({
        routes: [
          {
            path: "/api/data",
            method: "GET",
            controller: null,
            routePrefix: null,
            params: [],
            requestBody: null,
            responses: [],
            auth: null,
            middleware: [],
            description: null,
            source: "Program.cs",
          },
        ],
        errors: [
          {
            file: "/test/repo",
            reason: "NuGet restore failed \u2014 type resolution limited",
          },
        ],
      });

      __mockExecFileAsync.mockResolvedValue({
        stdout: analyzerOutput,
        stderr: "Warning: some packages missing",
      });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(1);
      // Should have both the stderr warning and the analyzer error
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some((e) => e.reason.includes("Analyzer warning"))).toBe(true);
      expect(result.errors.some((e) => e.reason.includes("NuGet restore failed"))).toBe(true);
    });
  });

  describe("CLI error (process failure)", () => {
    it("should return errors when the CLI process fails", async () => {
      const err = new Error("dotnet not found") as Error & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      err.killed = false;
      err.stderr = "Command 'dotnet' not found";

      __mockExecFileAsync.mockRejectedValue(err);

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("Analyzer error");
      expect(result.errors[0].reason).toContain("dotnet");
    });

    it("should return errors with process exit code details", async () => {
      const err = new Error("Process exited with code 1") as Error & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      err.killed = false;
      err.stderr = "Unhandled exception. System.IO.FileNotFoundException";

      __mockExecFileAsync.mockRejectedValue(err);

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("FileNotFoundException");
    });
  });

  describe("CLI timeout", () => {
    it("should return a timeout error when the process is killed", async () => {
      const err = new Error("Process timed out") as Error & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      err.killed = true;
      err.signal = "SIGTERM";

      __mockExecFileAsync.mockRejectedValue(err);

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("timed out");
      expect(result.errors[0].file).toBe("/test/repo");
    });

    it("should return a timeout error when SIGTERM signal is received", async () => {
      const err = new Error("killed") as Error & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      err.killed = false;
      err.signal = "SIGTERM";

      __mockExecFileAsync.mockRejectedValue(err);

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("timed out");
    });
  });

  describe("invalid JSON output", () => {
    it("should return an error when output is not valid JSON", async () => {
      __mockExecFileAsync.mockResolvedValue({
        stdout: "This is not JSON at all {{{",
        stderr: "",
      });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("Invalid JSON output");
    });

    it("should return an error when output is empty", async () => {
      __mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("empty output");
    });

    it("should return an error when output is only whitespace", async () => {
      __mockExecFileAsync.mockResolvedValue({ stdout: "   \n  \t  ", stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("empty output");
    });

    it("should truncate long invalid output in error message", async () => {
      const longOutput = "x".repeat(500);
      __mockExecFileAsync.mockResolvedValue({ stdout: longOutput, stderr: "" });

      const result = await parseDotnet("/test/repo");

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason.length).toBeLessThan(longOutput.length);
    });
  });

  describe("execFile call arguments", () => {
    it("should call dotnet with correct arguments", async () => {
      const analyzerOutput = JSON.stringify({ routes: [], errors: [] });
      __mockExecFileAsync.mockResolvedValue({ stdout: analyzerOutput, stderr: "" });

      await parseDotnet("/my/repo/path");

      expect(__mockExecFileAsync).toHaveBeenCalledTimes(1);

      const callArgs = __mockExecFileAsync.mock.calls[0];
      expect(callArgs[0]).toBe("dotnet");
      expect(callArgs[1]).toEqual([
        "/mock/path/ASTronautAnalyzer.dll",
        "/my/repo/path",
      ]);
      expect(callArgs[2]).toMatchObject({
        timeout: 60000, // config.timeouts.parseMs default
        maxBuffer: 10 * 1024 * 1024,
      });
    });
  });
});
