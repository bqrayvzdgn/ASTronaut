jest.mock("../../src/config", () => ({
  config: {
    github: { appId: "test", privateKeyPath: "/test.pem", webhookSecret: "secret" },
    timeouts: { cloneMs: 30000, parseMs: 60000, prMs: 15000 },
    limits: { maxConcurrentAnalyses: 3, rateLimitPerHour: 10 },
    userAgent: "ASTronaut-test/1.0.0",
  },
}));

jest.mock("../../src/utils/logger", () => ({
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
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

const mockGetValidToken = jest.fn().mockResolvedValue("mock-token");
jest.mock("../../src/github/appAuth", () => ({
  getValidToken: mockGetValidToken,
}));

const mockCheckRepoPermissions = jest.fn().mockResolvedValue({ canPush: true, archived: false });
const mockCreatePR = jest.fn().mockResolvedValue({ prNumber: 1, prUrl: "https://example.com/pr/1" });
jest.mock("../../src/github/prService", () => ({
  checkRepoPermissions: mockCheckRepoPermissions,
  createPR: mockCreatePR,
}));

const mockCloneRepo = jest.fn().mockResolvedValue("/tmp/test-repo");
const mockRemoveSensitiveFiles = jest.fn().mockResolvedValue(undefined);
const mockCleanup = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/github/repoManager", () => ({
  cloneRepo: mockCloneRepo,
  removeSensitiveFiles: mockRemoveSensitiveFiles,
  cleanup: mockCleanup,
}));

jest.mock("../../src/config/autodocConfig", () => ({
  loadAutodocConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../src/parser/registry", () => ({
  detectAndParse: jest.fn().mockResolvedValue({
    routes: [{ path: "/api/test", method: "GET", controller: null, routePrefix: null, params: [], requestBody: null, responses: [], auth: null, middleware: [], description: null, source: "test.ts" }],
    errors: [],
  }),
}));

jest.mock("../../src/generator/openApiGenerator", () => ({
  generateOpenApiSpec: jest.fn().mockReturnValue("openapi: 3.0.3\ninfo:\n  title: test"),
}));

// DB mocks
const mockUpdateWhere = jest.fn().mockResolvedValue({ rowCount: 1 });
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockDbUpdate = jest.fn(() => ({ set: mockUpdateSet }));

const mockInsertReturning = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockInsertValues = jest.fn(() => ({ returning: mockInsertReturning }));
const mockDbInsert = jest.fn(() => ({ values: mockInsertValues }));

const mockSelectLimit = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockSelectWhere = jest.fn(() => ({ limit: mockSelectLimit }));
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockDbSelect = jest.fn(() => ({ from: mockSelectFrom }));

jest.mock("../../src/db/connection", () => ({
  db: {
    update: mockDbUpdate,
    insert: mockDbInsert,
    select: mockDbSelect,
  },
}));

jest.mock("../../src/db/schema", () => ({
  analyses: {},
  installations: { githubInstallationId: "github_installation_id" },
  repos: { repoFullName: "repo_full_name" },
  webhookEvents: { id: "id" },
}));

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => ({
    rest: {
      repos: { listTags: jest.fn().mockResolvedValue({ data: [] }) },
    },
  })),
}));

import { processAnalysis } from "../../src/pipeline/processAnalysis";
import type { QueueItem } from "../../src/queue/analysisQueue";

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "test-item",
    repoFullName: "owner/repo",
    payload: {
      repository: { owner: { login: "owner" }, name: "repo" },
      installation: { id: 123 },
      workflow_run: { head_sha: "abc1234567890" },
    },
    addedAt: Date.now(),
    ...overrides,
  };
}

describe("processAnalysis", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidToken.mockResolvedValue("mock-token");
    mockCheckRepoPermissions.mockResolvedValue({ canPush: true, archived: false });
    mockCloneRepo.mockResolvedValue("/tmp/test-repo");
    mockSelectLimit.mockResolvedValue([{ id: 1 }]);
  });

  it("should complete the full pipeline successfully", async () => {
    await processAnalysis(makeQueueItem());

    expect(mockGetValidToken).toHaveBeenCalledWith(123);
    expect(mockCloneRepo).toHaveBeenCalled();
    expect(mockRemoveSensitiveFiles).toHaveBeenCalled();
    expect(mockCreatePR).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledWith("/tmp/test-repo");
  });

  it("should return early on malformed payload", async () => {
    const item = makeQueueItem({ payload: {} });
    await processAnalysis(item);

    expect(mockGetValidToken).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });

  it("should skip analysis when repo has no push permission", async () => {
    mockCheckRepoPermissions.mockResolvedValue({ canPush: false, archived: false });

    await processAnalysis(makeQueueItem());

    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it("should skip analysis when repo is archived", async () => {
    mockCheckRepoPermissions.mockResolvedValue({ canPush: true, archived: true });

    await processAnalysis(makeQueueItem());

    expect(mockCloneRepo).not.toHaveBeenCalled();
  });

  it("should cleanup even on error", async () => {
    mockCreatePR.mockRejectedValueOnce(new Error("PR creation failed"));

    await expect(processAnalysis(makeQueueItem())).rejects.toThrow("PR creation failed");
    expect(mockCleanup).toHaveBeenCalledWith("/tmp/test-repo");
  });

  it("should propagate token fetch errors", async () => {
    mockGetValidToken.mockRejectedValueOnce(new Error("Auth failed"));

    await expect(processAnalysis(makeQueueItem())).rejects.toThrow("Auth failed");
  });

  it("should update webhook status to processing", async () => {
    await processAnalysis(makeQueueItem({ webhookEventId: 42 }));

    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("should pass version to createPR", async () => {
    await processAnalysis(makeQueueItem());

    expect(mockCreatePR).toHaveBeenCalledWith(
      expect.objectContaining({
        version: expect.any(String),
      })
    );
  });
});
