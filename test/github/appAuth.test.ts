const mockReadFileSync = jest.fn().mockReturnValue("mock-private-key");

jest.mock("fs", () => ({
  readFileSync: mockReadFileSync,
}));

// Mock jose — importPKCS8 returns a fake key, SignJWT builds a chainable that produces a token
const mockSign = jest.fn().mockResolvedValue("mock-jwt-token");
jest.mock("jose", () => {
  const signInstance = {
    setProtectedHeader: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    sign: mockSign,
  };
  return {
    importPKCS8: jest.fn().mockResolvedValue("mock-key-object"),
    SignJWT: jest.fn().mockImplementation(() => signInstance),
  };
});

jest.mock("../../src/config", () => ({
  config: {
    github: {
      appId: "12345",
      privateKeyPath: "/test/key.pem",
      webhookSecret: "test-secret",
    },
    userAgent: "ASTronaut/1.0.0",
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
import { SignJWT } from "jose";

describe("appAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReturnValue("mock-private-key");
    mockSign.mockResolvedValue("mock-jwt-token");
  });

  describe("createAppOctokit", () => {
    it("should create an Octokit instance with JWT auth", async () => {
      const octokit = await createAppOctokit();
      expect(octokit).toBeDefined();
      expect(SignJWT).toHaveBeenCalledWith(
        expect.objectContaining({ iss: "12345" })
      );
    });

    it("should use RS256 algorithm", async () => {
      await createAppOctokit();
      const instance = (SignJWT as unknown as jest.Mock).mock.results[0].value;
      expect(instance.setProtectedHeader).toHaveBeenCalledWith({ alg: "RS256" });
    });
  });

  describe("getValidToken", () => {
    it("should reuse cached token when not near expiry", async () => {
      const futureDate = new Date(Date.now() + 30 * 60 * 1000);
      mockSelectLimit.mockResolvedValueOnce([{
        accessToken: "cached-token",
        tokenExpiresAt: futureDate,
      }]);

      const token = await getValidToken(123);
      expect(token).toBe("cached-token");
      expect(mockOctokitRequest).not.toHaveBeenCalled();
    });

    it("should refresh token when near expiry", async () => {
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000);
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
      expect(mockInsert).toHaveBeenCalled();
    });
  });
});
