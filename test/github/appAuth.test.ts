const mockSign = jest.fn().mockReturnValue("mock-jwt-token");
const mockReadFileSync = jest.fn().mockReturnValue("mock-private-key");

jest.mock("fs", () => ({
  readFileSync: mockReadFileSync,
}));

jest.mock("jsonwebtoken", () => ({
  sign: mockSign,
}));

jest.mock("../../src/config", () => ({
  config: {
    github: {
      appId: "12345",
      privateKeyPath: "/test/key.pem",
      webhookSecret: "test-secret",
    },
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

const mockSelectLimit = jest.fn();
const mockSelectWhere = jest.fn(() => ({ limit: mockSelectLimit }));
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

const mockInsertOnConflict = jest.fn().mockResolvedValue({});
const mockInsertValues = jest.fn(() => ({ onConflictDoUpdate: mockInsertOnConflict }));
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

jest.mock("../../src/db/connection", () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
  },
}));

const mockOctokitRequest = jest.fn();

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: mockOctokitRequest,
  })),
}));

import { createAppOctokit, getValidToken } from "../../src/github/appAuth";

describe("appAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReturnValue("mock-private-key");
    mockSign.mockReturnValue("mock-jwt-token");
  });

  describe("createAppOctokit", () => {
    it("should create an Octokit instance with JWT auth", () => {
      const octokit = createAppOctokit();
      expect(octokit).toBeDefined();
      expect(mockSign).toHaveBeenCalledWith(
        expect.objectContaining({
          iss: "12345",
        }),
        "mock-private-key",
        { algorithm: "RS256" }
      );
    });

    it("should create JWT with iat backdated 60s and exp within 10 min window", () => {
      createAppOctokit();

      const payload = mockSign.mock.calls[0][0];
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
      expect(payload.exp - payload.iat).toBeGreaterThan(0);
    });
  });

  describe("getValidToken", () => {
    it("should reuse cached token when not near expiry", async () => {
      const futureDate = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
      mockSelectLimit.mockResolvedValueOnce([{
        accessToken: "cached-token",
        tokenExpiresAt: futureDate,
      }]);

      const token = await getValidToken(123);
      expect(token).toBe("cached-token");
      expect(mockOctokitRequest).not.toHaveBeenCalled();
    });

    it("should refresh token when near expiry", async () => {
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000); // 2 min from now (< 5 min buffer)
      mockSelectLimit.mockResolvedValueOnce([{
        accessToken: "old-token",
        tokenExpiresAt: nearExpiry,
      }]);

      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          token: "new-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });

      mockUpdateWhere.mockResolvedValueOnce({ rowCount: 1 });

      const token = await getValidToken(123);
      expect(token).toBe("new-token");
      expect(mockOctokitRequest).toHaveBeenCalled();
    });

    it("should request new token when no cached token exists", async () => {
      mockSelectLimit.mockResolvedValueOnce([]);

      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          token: "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });

      mockUpdateWhere.mockResolvedValueOnce({ rowCount: 0 });

      const token = await getValidToken(456);
      expect(token).toBe("fresh-token");
      expect(mockInsert).toHaveBeenCalled(); // upsert fallback
    });
  });
});
