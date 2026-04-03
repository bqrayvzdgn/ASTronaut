import fs from "fs";
import path from "path";
import os from "os";
import {
  parseNextSource,
  parseNextRoutes,
  filePathToRoutePath,
} from "../../src/parser/nextParser";

// Mock logger
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseApp(code: string, filePath = "api/users") {
  return parseNextSource(code, filePath, "app");
}

function parsePages(code: string, filePath = "users.ts") {
  return parseNextSource(code, filePath, "pages");
}

// ---------------------------------------------------------------------------
// 1. File path → Route path conversion
// ---------------------------------------------------------------------------

describe("nextParser", () => {
  describe("filePathToRoutePath", () => {
    it("should convert App Router paths", () => {
      expect(filePathToRoutePath("api/users", "app")).toBe("/api/users");
      expect(filePathToRoutePath("api/users/[id]", "app")).toBe(
        "/api/users/:id"
      );
      expect(filePathToRoutePath("api/posts/[...slug]", "app")).toBe(
        "/api/posts/:slug*"
      );
    });

    it("should strip route groups", () => {
      expect(filePathToRoutePath("(admin)/api/users", "app")).toBe(
        "/api/users"
      );
      expect(
        filePathToRoutePath("(auth)/(dashboard)/api/settings", "app")
      ).toBe("/api/settings");
    });

    it("should convert Pages Router paths", () => {
      expect(filePathToRoutePath("users.ts", "pages")).toBe("/api/users");
      expect(filePathToRoutePath("users/index.ts", "pages")).toBe(
        "/api/users"
      );
      expect(filePathToRoutePath("users/[id].ts", "pages")).toBe(
        "/api/users/:id"
      );
    });

    it("should handle catch-all routes", () => {
      expect(filePathToRoutePath("api/[...slug]", "app")).toBe(
        "/api/:slug*"
      );
      expect(filePathToRoutePath("[...slug].ts", "pages")).toBe(
        "/api/:slug*"
      );
    });

    it("should handle optional catch-all routes", () => {
      expect(filePathToRoutePath("api/[[...slug]]", "app")).toBe(
        "/api/:slug*"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. App Router — named export functions
  // ---------------------------------------------------------------------------

  describe("App Router", () => {
    it("should detect export async function GET", () => {
      const result = parseApp(`
        export async function GET(request: Request) {
          return Response.json({ users: [] });
        }
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users");
      expect(result.routes[0].method).toBe("GET");
      expect(result.routes[0].controller).toBe("GET");
    });

    it("should detect multiple method exports", () => {
      const result = parseApp(`
        export async function GET(request: Request) {
          return Response.json([]);
        }

        export async function POST(request: Request) {
          const body = await request.json();
          return Response.json({ created: true });
        }
      `);

      expect(result.routes).toHaveLength(2);
      expect(result.routes.map((r) => r.method).sort()).toEqual([
        "GET",
        "POST",
      ]);
    });

    it("should detect export const GET = arrow function", () => {
      const result = parseApp(`
        export const GET = async (request: Request) => {
          return Response.json([]);
        };
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].method).toBe("GET");
      expect(result.routes[0].controller).toBe("GET");
    });

    it("should extract path params from dynamic route", () => {
      const result = parseApp(
        `
        export async function GET(
          request: Request,
          { params }: { params: { id: string } }
        ) {
          return Response.json({ id: params.id });
        }
      `,
        "api/users/[id]"
      );

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users/:id");
      expect(result.routes[0].params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "id",
            in: "path",
            required: true,
          }),
        ])
      );
    });

    it("should detect request.json() as request body", () => {
      const result = parseApp(`
        export async function POST(request: Request) {
          const body = await request.json();
          return Response.json(body);
        }
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].requestBody).not.toBeNull();
      expect(result.routes[0].requestBody?.type).toBe("object");
    });

    it("should detect searchParams.get() as query params", () => {
      const result = parseApp(`
        export async function GET(request: Request) {
          const { searchParams } = new URL(request.url);
          const page = searchParams.get('page');
          const limit = searchParams.get('limit');
          return Response.json([]);
        }
      `);

      expect(result.routes).toHaveLength(1);
      const queryParams = result.routes[0].params.filter(
        (p) => p.in === "query"
      );
      expect(queryParams).toHaveLength(2);
      expect(queryParams.map((p) => p.name).sort()).toEqual(["limit", "page"]);
    });

    it("should detect nextUrl.searchParams.get() as query params", () => {
      const result = parseApp(`
        export async function GET(request: NextRequest) {
          const page = request.nextUrl.searchParams.get('page');
          return Response.json([]);
        }
      `);

      expect(result.routes).toHaveLength(1);
      const queryParams = result.routes[0].params.filter(
        (p) => p.in === "query"
      );
      expect(queryParams).toHaveLength(1);
      expect(queryParams[0].name).toBe("page");
    });

    it("should handle route groups by stripping them", () => {
      const result = parseApp(
        `
        export async function GET() {
          return Response.json([]);
        }
      `,
        "(admin)/api/users"
      );

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users");
    });

    it("should handle catch-all routes", () => {
      const result = parseApp(
        `
        export async function GET(
          request: Request,
          { params }: { params: { slug: string[] } }
        ) {
          return Response.json({ slug: params.slug });
        }
      `,
        "api/docs/[...slug]"
      );

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/docs/:slug*");
      expect(result.routes[0].params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "slug",
            in: "path",
            type: "string[]",
          }),
        ])
      );
    });

    it("should extract JSDoc description", () => {
      const result = parseApp(`
        /** List all users */
        export async function GET(request: Request) {
          return Response.json([]);
        }
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].description).toBe("List all users");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Pages Router — default export handler
  // ---------------------------------------------------------------------------

  describe("Pages Router", () => {
    it("should detect default export handler as GET", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          res.json({ users: [] });
        }
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users");
      expect(result.routes[0].method).toBe("GET");
    });

    it("should detect methods from req.method === checks", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          if (req.method === 'GET') {
            res.json([]);
          } else if (req.method === 'POST') {
            res.status(201).json({});
          }
        }
      `);

      expect(result.routes).toHaveLength(2);
      expect(result.routes.map((r) => r.method).sort()).toEqual([
        "GET",
        "POST",
      ]);
    });

    it("should detect methods from switch statement", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          switch (req.method) {
            case 'GET':
              res.json([]);
              break;
            case 'POST':
              res.status(201).json({});
              break;
            case 'DELETE':
              res.status(204).end();
              break;
          }
        }
      `);

      expect(result.routes).toHaveLength(3);
      expect(result.routes.map((r) => r.method).sort()).toEqual([
        "DELETE",
        "GET",
        "POST",
      ]);
    });

    it("should extract path params from dynamic route", () => {
      const result = parsePages(
        `
        export default function handler(req, res) {
          const { id } = req.query;
          res.json({ id });
        }
      `,
        "users/[id].ts"
      );

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users/:id");
      expect(result.routes[0].params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "id",
            in: "path",
            required: true,
          }),
        ])
      );
    });

    it("should extract req.query params", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          const page = req.query.page;
          const limit = req.query.limit;
          res.json([]);
        }
      `);

      expect(result.routes).toHaveLength(1);
      const queryParams = result.routes[0].params.filter(
        (p) => p.in === "query"
      );
      expect(queryParams).toHaveLength(2);
      expect(queryParams.map((p) => p.name).sort()).toEqual(["limit", "page"]);
    });

    it("should extract req.body", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          if (req.method === 'POST') {
            const { name, email } = req.body;
            res.status(201).json({ name, email });
          }
        }
      `);

      const postRoute = result.routes.find((r) => r.method === "POST");
      expect(postRoute).toBeDefined();
      expect(postRoute!.requestBody).not.toBeNull();
      expect(postRoute!.requestBody?.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "name" }),
          expect.objectContaining({ name: "email" }),
        ])
      );
    });

    it("should not attach request body to GET routes", () => {
      const result = parsePages(`
        export default function handler(req, res) {
          if (req.method === 'GET') {
            res.json([]);
          } else if (req.method === 'POST') {
            const data = req.body;
            res.status(201).json(data);
          }
        }
      `);

      const getRoute = result.routes.find((r) => r.method === "GET");
      expect(getRoute!.requestBody).toBeNull();

      const postRoute = result.routes.find((r) => r.method === "POST");
      expect(postRoute!.requestBody).not.toBeNull();
    });

    it("should handle arrow function default export", () => {
      const result = parsePages(`
        export default (req, res) => {
          res.json([]);
        };
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].method).toBe("GET");
    });

    it("should handle index.ts files", () => {
      const result = parsePages(
        `
        export default function handler(req, res) {
          res.json([]);
        }
      `,
        "users/index.ts"
      );

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/api/users");
    });

    it("should report error when no default export found", () => {
      const result = parsePages(`
        function notExported(req, res) {
          res.json([]);
        }
      `);

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("No default export");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. File system integration (parseNextRoutes)
  // ---------------------------------------------------------------------------

  describe("parseNextRoutes - file system", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nextparser-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true });
    });

    it("should discover and parse App Router route files", () => {
      // Create app/api/users/route.ts
      const routeDir = path.join(tmpDir, "app", "api", "users");
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        path.join(routeDir, "route.ts"),
        `
        export async function GET(request: Request) {
          return Response.json([]);
        }

        export async function POST(request: Request) {
          const body = await request.json();
          return Response.json(body);
        }
      `
      );

      return parseNextRoutes(tmpDir).then((result) => {
        expect(result.routes).toHaveLength(2);
        expect(result.routes.map((r) => r.method).sort()).toEqual([
          "GET",
          "POST",
        ]);
        expect(result.routes[0].path).toBe("/api/users");
      });
    });

    it("should discover and parse Pages Router files", () => {
      // Create pages/api/users.ts
      const pagesDir = path.join(tmpDir, "pages", "api");
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "users.ts"),
        `
        export default function handler(req, res) {
          if (req.method === 'GET') {
            res.json([]);
          } else if (req.method === 'POST') {
            res.status(201).json({});
          }
        }
      `
      );

      return parseNextRoutes(tmpDir).then((result) => {
        expect(result.routes).toHaveLength(2);
        expect(result.routes.map((r) => r.method).sort()).toEqual([
          "GET",
          "POST",
        ]);
      });
    });

    it("should discover routes under src/ prefix", () => {
      // Create src/app/api/health/route.ts
      const routeDir = path.join(tmpDir, "src", "app", "api", "health");
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        path.join(routeDir, "route.ts"),
        `
        export async function GET() {
          return Response.json({ status: 'ok' });
        }
      `
      );

      return parseNextRoutes(tmpDir).then((result) => {
        expect(result.routes).toHaveLength(1);
        expect(result.routes[0].path).toBe("/api/health");
      });
    });

    it("should handle dynamic route directories", () => {
      // Create app/api/users/[id]/route.ts
      const routeDir = path.join(tmpDir, "app", "api", "users", "[id]");
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        path.join(routeDir, "route.ts"),
        `
        export async function GET(
          request: Request,
          { params }: { params: { id: string } }
        ) {
          return Response.json({ id: params.id });
        }

        export async function DELETE(
          request: Request,
          { params }: { params: { id: string } }
        ) {
          return new Response(null, { status: 204 });
        }
      `
      );

      return parseNextRoutes(tmpDir).then((result) => {
        expect(result.routes).toHaveLength(2);
        expect(result.routes[0].path).toBe("/api/users/:id");
        expect(result.routes[0].params).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "id", in: "path" }),
          ])
        );
      });
    });

    it("should exclude .next directory", () => {
      // Create .next/server/app/api/users/route.ts (build output)
      const buildDir = path.join(
        tmpDir,
        ".next",
        "server",
        "app",
        "api",
        "users"
      );
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(
        path.join(buildDir, "route.ts"),
        `export async function GET() { return Response.json([]); }`
      );

      // Create actual source
      const sourceDir = path.join(tmpDir, "app", "api", "users");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "route.ts"),
        `export async function GET() { return Response.json([]); }`
      );

      return parseNextRoutes(tmpDir).then((result) => {
        expect(result.routes).toHaveLength(1);
        expect(result.routes[0].source).not.toContain(".next");
      });
    });
  });
});
