import crypto from "crypto";

const WEBHOOK_SECRET = "test-webhook-secret";

jest.mock("../../src/config", () => ({
  config: {
    github: {
      webhookSecret: "test-webhook-secret",
      appId: "test",
      privateKeyPath: "/test.pem",
    },
    limits: { rateLimitPerHour: 10 },
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  },
}));

const mockEnqueue = jest.fn();
jest.mock("../../src/queue/analysisQueue", () => ({
  analysisQueue: { enqueue: mockEnqueue },
  QueueItem: {},
}));

const mockCheckRateLimit = jest.fn().mockReturnValue(true);
jest.mock("../../src/utils/rateLimiter", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// DB mock
const mockDbReturning = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockDbOnConflict = jest.fn(() => ({ returning: mockDbReturning }));
const mockDbValues = jest.fn(() => ({
  returning: mockDbReturning,
  onConflictDoNothing: mockDbOnConflict,
}));
const mockDbInsert = jest.fn(() => ({ values: mockDbValues }));
const mockDbSelectLimit = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockDbSelectWhere = jest.fn(() => ({ limit: mockDbSelectLimit }));
const mockDbSelectFrom = jest.fn(() => ({ where: mockDbSelectWhere }));
const mockDbSelect = jest.fn(() => ({ from: mockDbSelectFrom }));
const mockDbDeleteWhere = jest.fn().mockResolvedValue({});
const mockDbDelete = jest.fn(() => ({ where: mockDbDeleteWhere }));

jest.mock("../../src/db/connection", () => ({
  db: {
    insert: mockDbInsert,
    select: mockDbSelect,
    delete: mockDbDelete,
  },
}));

jest.mock("../../src/db/schema", () => ({
  webhookEvents: { id: "id" },
  installations: { id: "id", githubInstallationId: "github_installation_id" },
  repos: { id: "id", installationId: "installation_id", repoFullName: "repo_full_name" },
}));

import { webhookHandler } from "../../src/api/webhookHandler";

function makeSignature(body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")
  );
}

function makeReq(overrides: any = {}) {
  const body = overrides.body ?? {
    action: "completed",
    workflow_run: { conclusion: "success", head_sha: "abc123" },
    repository: { full_name: "owner/repo", name: "repo", owner: { login: "owner" } },
    installation: { id: 123, account: { login: "owner" } },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    headers: {
      "x-hub-signature-256": makeSignature(rawBody.toString()),
      "x-github-event": overrides.event ?? "workflow_run",
      ...overrides.headers,
    },
    body,
    rawBody,
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("webhookHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockReturnValue(true);
    mockDbReturning.mockResolvedValue([{ id: 1 }]);
    mockDbSelectLimit.mockResolvedValue([{ id: 1 }]);
  });

  describe("signature verification", () => {
    it("should reject missing signature", async () => {
      const req = makeReq({ headers: {} });
      delete req.headers["x-hub-signature-256"];
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should reject invalid signature", async () => {
      const req = makeReq();
      req.headers["x-hub-signature-256"] = "sha256=invalid";
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should reject missing rawBody", async () => {
      const req = makeReq();
      delete req.rawBody;
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should accept valid signature", async () => {
      const req = makeReq();
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(202);
    });
  });

  describe("event dispatch", () => {
    it("should ignore unknown event types", async () => {
      const req = makeReq({ event: "push" });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ignored: true })
      );
    });

    it("should handle workflow_run completed success", async () => {
      const req = makeReq();
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(202);
      expect(mockEnqueue).toHaveBeenCalled();
    });

    it("should ignore workflow_run with non-completed action", async () => {
      const req = makeReq({
        body: {
          action: "requested",
          workflow_run: { conclusion: "success", head_sha: "abc" },
          repository: { full_name: "o/r", name: "r", owner: { login: "o" } },
          installation: { id: 1, account: { login: "o" } },
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("should ignore workflow_run with non-success conclusion", async () => {
      const req = makeReq({
        body: {
          action: "completed",
          workflow_run: { conclusion: "failure", head_sha: "abc" },
          repository: { full_name: "o/r", name: "r", owner: { login: "o" } },
          installation: { id: 1, account: { login: "o" } },
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe("rate limiting", () => {
    it("should reject when rate limit exceeded", async () => {
      mockCheckRateLimit.mockReturnValue(false);
      const req = makeReq();
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  describe("installation events", () => {
    it("should handle installation.created", async () => {
      const req = makeReq({
        event: "installation",
        body: {
          action: "created",
          installation: { id: 456, account: { login: "test-owner" } },
          repositories: [{ name: "repo1", full_name: "test-owner/repo1" }],
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should handle installation.deleted", async () => {
      const req = makeReq({
        event: "installation",
        body: {
          action: "deleted",
          installation: { id: 456, account: { login: "test-owner" } },
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockDbDelete).toHaveBeenCalled();
    });

    it("should reject malformed installation event", async () => {
      const req = makeReq({
        event: "installation",
        body: { action: "created" },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe("installation_repositories events", () => {
    it("should handle repositories added", async () => {
      const req = makeReq({
        event: "installation_repositories",
        body: {
          action: "added",
          installation: { id: 456 },
          repositories_added: [{ name: "new-repo", full_name: "owner/new-repo" }],
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should handle repositories removed", async () => {
      const req = makeReq({
        event: "installation_repositories",
        body: {
          action: "removed",
          installation: { id: 456 },
          repositories_removed: [{ full_name: "owner/old-repo" }],
        },
      });
      const res = makeRes();

      await webhookHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
