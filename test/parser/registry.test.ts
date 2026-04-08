jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// We need to isolate registry state between tests
let registerFramework: typeof import("../../src/parser/registry").registerFramework;
let detectAndParse: typeof import("../../src/parser/registry").detectAndParse;
let getAllFrameworkModules: typeof import("../../src/parser/registry").getAllFrameworkModules;
let getFrameworkModule: typeof import("../../src/parser/registry").getFrameworkModule;

beforeEach(() => {
  jest.resetModules();
  const registry = require("../../src/parser/registry");
  registerFramework = registry.registerFramework;
  detectAndParse = registry.detectAndParse;
  getAllFrameworkModules = registry.getAllFrameworkModules;
  getFrameworkModule = registry.getFrameworkModule;
});

const mockParseResult = {
  routes: [{ path: "/test", method: "GET" as const, controller: null, routePrefix: null, params: [], requestBody: null, responses: [], auth: null, middleware: [], description: null, source: "test.ts" }],
  errors: [],
};

function makeMockModule(id: string, detectScore: number) {
  return {
    id,
    name: `Mock ${id}`,
    languages: ["test"] as readonly string[],
    detect: jest.fn().mockResolvedValue(detectScore),
    parse: jest.fn().mockResolvedValue(mockParseResult),
  };
}

describe("Parser Registry", () => {
  it("should register a framework module", () => {
    const mod = makeMockModule("test-fw", 1);
    registerFramework(mod);

    expect(getFrameworkModule("test-fw")).toBe(mod);
    expect(getAllFrameworkModules()).toHaveLength(1);
  });

  it("should throw on duplicate registration", () => {
    const mod = makeMockModule("dup-fw", 1);
    registerFramework(mod);

    expect(() => registerFramework(mod)).toThrow('Framework module "dup-fw" is already registered');
  });

  it("should detect and parse using the highest scoring module", async () => {
    const low = makeMockModule("low", 1);
    const high = makeMockModule("high", 2);
    registerFramework(low);
    registerFramework(high);

    await detectAndParse("/some/repo");

    expect(low.detect).toHaveBeenCalledWith("/some/repo");
    expect(high.detect).toHaveBeenCalledWith("/some/repo");
    expect(high.parse).toHaveBeenCalledWith("/some/repo");
    expect(low.parse).not.toHaveBeenCalled();
  });

  it("should throw when no module can detect the repo", async () => {
    const mod = makeMockModule("none", 0);
    registerFramework(mod);

    await expect(detectAndParse("/some/repo")).rejects.toThrow("No supported framework detected");
  });

  it("should use config override to bypass detection", async () => {
    const mod = makeMockModule("express", 0); // detect returns 0 but override forces it
    registerFramework(mod);

    await detectAndParse("/some/repo", { framework: "express" });

    expect(mod.detect).not.toHaveBeenCalled();
    expect(mod.parse).toHaveBeenCalledWith("/some/repo");
  });

  it("should fall back to detection when config override module not found", async () => {
    const mod = makeMockModule("express", 1);
    registerFramework(mod);

    await detectAndParse("/some/repo", { framework: "unknown-fw" });

    expect(mod.detect).toHaveBeenCalled();
    expect(mod.parse).toHaveBeenCalled();
  });
});
