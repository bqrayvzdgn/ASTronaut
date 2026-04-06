jest.mock("../../src/config", () => ({
  config: {
    github: { appId: "test", privateKeyPath: "/test.pem", webhookSecret: "secret" },
    timeouts: { cloneMs: 30000, prMs: 15000 },
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

jest.mock("../../src/github/appAuth", () => ({
  getValidToken: jest.fn().mockResolvedValue("mock-token"),
}));

const mockOctokit = {
  rest: {
    repos: {
      get: jest.fn(),
      getContent: jest.fn(),
      createOrUpdateFileContents: jest.fn(),
    },
    git: {
      getRef: jest.fn(),
      createRef: jest.fn(),
    },
    pulls: {
      create: jest.fn(),
    },
  },
};

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => mockOctokit),
}));

import { checkRepoPermissions, createPR } from "../../src/github/prService";
import type { ParseResult } from "../../src/parser/types";

const emptyParseResult: ParseResult = { routes: [], errors: [] };
const sampleParseResult: ParseResult = {
  routes: [
    {
      path: "/api/users",
      method: "GET",
      controller: "UsersController",
      routePrefix: "/api",
      params: [],
      requestBody: null,
      responses: [{ status: 200, type: "User[]", properties: [] }],
      auth: null,
      middleware: [],
      description: null,
      source: "users.ts",
    },
  ],
  errors: [],
};

describe("prService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkRepoPermissions", () => {
    it("should return canPush true for repo with push permission", async () => {
      const octokit = {
        rest: {
          repos: {
            get: jest.fn().mockResolvedValue({
              data: { permissions: { push: true }, archived: false },
            }),
          },
        },
      } as any;

      const result = await checkRepoPermissions(octokit, "owner", "repo");
      expect(result.canPush).toBe(true);
      expect(result.archived).toBe(false);
    });

    it("should return archived true for archived repo", async () => {
      const octokit = {
        rest: {
          repos: {
            get: jest.fn().mockResolvedValue({
              data: { permissions: { push: true }, archived: true },
            }),
          },
        },
      } as any;

      const result = await checkRepoPermissions(octokit, "owner", "repo");
      expect(result.archived).toBe(true);
    });

    it("should return canPush false when no push permission", async () => {
      const octokit = {
        rest: {
          repos: {
            get: jest.fn().mockResolvedValue({
              data: { permissions: { push: false }, archived: false },
            }),
          },
        },
      } as any;

      const result = await checkRepoPermissions(octokit, "owner", "repo");
      expect(result.canPush).toBe(false);
    });
  });

  describe("createPR", () => {
    beforeEach(() => {
      mockOctokit.rest.repos.get.mockResolvedValue({
        data: { default_branch: "main" },
      });
      mockOctokit.rest.git.getRef.mockResolvedValue({
        data: { object: { sha: "base-sha-123" } },
      });
      mockOctokit.rest.git.createRef.mockResolvedValue({});
      mockOctokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
      mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
      mockOctokit.rest.pulls.create.mockResolvedValue({
        data: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
      });
    });

    it("should create a PR with correct structure", async () => {
      const result = await createPR({
        owner: "owner",
        repo: "repo",
        installationId: 123,
        spec: "openapi: 3.0.3",
        parseResult: sampleParseResult,
        commitSha: "abc1234567890",
        version: "1.0.0",
      });

      expect(result.prNumber).toBe(42);
      expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42");
    });

    it("should create branch from default branch HEAD", async () => {
      await createPR({
        owner: "owner",
        repo: "repo",
        installationId: 123,
        spec: "spec",
        parseResult: emptyParseResult,
        commitSha: "abc1234",
        version: "1.0.0",
      });

      expect(mockOctokit.rest.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({
          sha: "base-sha-123",
          ref: expect.stringMatching(/^refs\/heads\/astronaut\/docs-/),
        })
      );
    });

    it("should use custom docsOutput path", async () => {
      await createPR({
        owner: "owner",
        repo: "repo",
        installationId: 123,
        spec: "spec",
        parseResult: emptyParseResult,
        commitSha: "abc1234",
        version: "1.0.0",
        docsOutput: "api/spec.yaml",
      });

      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "api/spec.yaml",
        })
      );
    });

    it("should reject path traversal in docsOutput", async () => {
      await expect(
        createPR({
          owner: "owner",
          repo: "repo",
          installationId: 123,
          spec: "spec",
          parseResult: emptyParseResult,
          commitSha: "abc1234",
          version: "1.0.0",
          docsOutput: "../../.github/workflows/evil.yml",
        })
      ).rejects.toThrow("Unsafe file path rejected");
    });

    it("should include existing file SHA when updating", async () => {
      mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { type: "file", sha: "existing-sha-456" },
      });

      await createPR({
        owner: "owner",
        repo: "repo",
        installationId: 123,
        spec: "spec",
        parseResult: emptyParseResult,
        commitSha: "abc1234",
        version: "1.0.0",
      });

      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          sha: "existing-sha-456",
        })
      );
    });
  });
});
