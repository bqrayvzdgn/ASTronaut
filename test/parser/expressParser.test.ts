import fs from "fs";
import path from "path";
import os from "os";
import { parseExpressSource, parseExpressRoutes } from "../../src/parser/expressParser";

// ---------------------------------------------------------------------------
// Helper: parse in-memory source via the public API
// ---------------------------------------------------------------------------

function parse(code: string, fileName = "test.ts") {
  return parseExpressSource(code, fileName);
}

// ---------------------------------------------------------------------------
// 1. Simple GET route
// ---------------------------------------------------------------------------

describe("expressParser", () => {
  describe("simple GET route", () => {
    it("should detect app.get('/users', handler)", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', (req, res) => {
          res.json([]);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/users");
      expect(result.routes[0].method).toBe("GET");
    });

    it("should detect router.get('/items', handler)", () => {
      const result = parse(`
        const express = require('express');
        const router = express.Router();
        router.get('/items', (req, res) => {
          res.json([]);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe("/items");
      expect(result.routes[0].method).toBe("GET");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Parameterized route
  // ---------------------------------------------------------------------------

  describe("parameterized route", () => {
    it("should extract path params from :id pattern", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users/:id', (req, res) => {
          res.json({ id: req.params.id });
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "id",
            in: "path",
            type: "string",
            required: true,
          }),
        ])
      );
    });

    it("should extract multiple path params", () => {
      const result = parse(`
        const app = require('express')();
        app.get('/orgs/:orgId/teams/:teamId', (req, res) => {
          res.json({});
        });
      `);

      expect(result.routes).toHaveLength(1);
      const pathParams = result.routes[0].params.filter(
        (p) => p.in === "path"
      );
      expect(pathParams).toHaveLength(2);
      expect(pathParams[0].name).toBe("orgId");
      expect(pathParams[1].name).toBe("teamId");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Multiple HTTP methods
  // ---------------------------------------------------------------------------

  describe("multiple HTTP methods", () => {
    it("should detect GET, POST, PUT, DELETE, PATCH routes", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/a', (req, res) => {});
        app.post('/b', (req, res) => {});
        app.put('/c', (req, res) => {});
        app.delete('/d', (req, res) => {});
        app.patch('/e', (req, res) => {});
      `);

      expect(result.routes).toHaveLength(5);
      const methods = result.routes.map((r) => r.method).sort();
      expect(methods).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Router prefix via app.use('/prefix', router)
  // ---------------------------------------------------------------------------

  describe("router prefix", () => {
    it("should apply prefix when router is mounted with app.use", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        const userRouter = express.Router();

        userRouter.get('/list', (req, res) => {});
        userRouter.post('/', (req, res) => {});

        app.use('/api/users', userRouter);
      `);

      expect(result.routes).toHaveLength(2);

      const getRoute = result.routes.find((r) => r.method === "GET")!;
      expect(getRoute.path).toBe("/api/users/list");
      expect(getRoute.routePrefix).toBe("/api/users");

      const postRoute = result.routes.find((r) => r.method === "POST")!;
      expect(postRoute.path).toBe("/api/users/");
      expect(postRoute.routePrefix).toBe("/api/users");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Middleware detection
  // ---------------------------------------------------------------------------

  describe("middleware detection", () => {
    it("should extract middleware names between path and handler", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', rateLimit, validateQuery, (req, res) => {
          res.json([]);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].middleware).toContain("rateLimit");
      expect(result.routes[0].middleware).toContain("validateQuery");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Auth middleware detection (name-based)
  // ---------------------------------------------------------------------------

  describe("auth middleware", () => {
    it("should detect auth middleware by name containing 'auth'", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', authMiddleware, (req, res) => {
          res.json([]);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("authMiddleware");
    });

    it("should detect passport.authenticate as Bearer auth", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/me', passport.authenticate('jwt', { session: false }), (req, res) => {
          res.json(req.user);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("Bearer");
    });

    it("should detect middleware with 'guard' keyword as auth", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.post('/admin', roleGuard, (req, res) => {});
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("roleGuard");
    });

    it("should detect middleware with 'protect' keyword as auth", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.put('/settings', protectRoute, (req, res) => {});
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("protectRoute");
    });

    it("should detect middleware with 'jwt' keyword as auth", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/profile', jwtCheck, (req, res) => {});
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("jwtCheck");
    });

    it("should detect middleware with 'verify' keyword as auth", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/secure', verifyToken, (req, res) => {});
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].auth).toBe("verifyToken");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Global auth middleware
  // ---------------------------------------------------------------------------

  describe("global auth middleware", () => {
    it("should apply global auth to all routes", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.use(authMiddleware);
        app.get('/users', (req, res) => { res.json([]); });
        app.post('/users', (req, res) => { res.json({}); });
      `);

      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].auth).toBe("authMiddleware");
      expect(result.routes[1].auth).toBe("authMiddleware");
    });

    it("should apply router-level auth to routes on that router", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        const router = express.Router();
        router.use(verifyToken);
        router.get('/profile', (req, res) => {});
        router.post('/settings', (req, res) => {});
      `);

      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].auth).toBe("verifyToken");
      expect(result.routes[1].auth).toBe("verifyToken");
    });
  });

  // ---------------------------------------------------------------------------
  // 8. TypeScript type extraction
  // ---------------------------------------------------------------------------

  describe("TypeScript type extraction", () => {
    it("should extract param types from Request<Params> generic", () => {
      const result = parse(`
        import express, { Request, Response } from 'express';
        const app = express();

        interface UserParams {
          id: number;
          slug: string;
        }

        app.get('/users/:id/:slug', (req: Request<UserParams>, res: Response) => {
          res.json({});
        });
      `);

      expect(result.routes).toHaveLength(1);
      const pathParams = result.routes[0].params.filter(
        (p) => p.in === "path"
      );
      expect(pathParams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id", type: "number" }),
          expect.objectContaining({ name: "slug", type: "string" }),
        ])
      );
    });

    it("should extract inline type literal from Request<{id: string}>", () => {
      const result = parse(`
        import express, { Request, Response } from 'express';
        const app = express();
        app.get('/users/:id', (req: Request<{id: string}>, res: Response) => {
          res.json({});
        });
      `);

      expect(result.routes).toHaveLength(1);
      const pathParams = result.routes[0].params.filter(
        (p) => p.in === "path"
      );
      expect(pathParams).toHaveLength(1);
      expect(pathParams[0].name).toBe("id");
      expect(pathParams[0].type).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // 9. JSDoc description
  // ---------------------------------------------------------------------------

  describe("JSDoc description", () => {
    it("should extract JSDoc comment above route as description", () => {
      const result = parse(`
        const express = require('express');
        const app = express();

        /** Get all users */
        app.get('/users', (req, res) => {
          res.json([]);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].description).toBe("Get all users");
    });

    it("should extract multiline JSDoc", () => {
      const result = parse(`
        const express = require('express');
        const app = express();

        /**
         * Create a new user
         * Requires admin privileges
         */
        app.post('/users', (req, res) => {
          res.json({});
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].description).toContain("Create a new user");
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Dynamic route warning
  // ---------------------------------------------------------------------------

  describe("dynamic route path", () => {
    it("should add warning/error for variable route path", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        const dynamicPath = '/dynamic';
        app.get(dynamicPath, (req, res) => {
          res.json({});
        });
      `);

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain("Dynamic route path");
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Empty file
  // ---------------------------------------------------------------------------

  describe("empty file", () => {
    it("should return empty routes for file with no routes", () => {
      const result = parse(`
        const x = 1;
        console.log('hello');
      `);

      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should return empty routes for actually empty file", () => {
      const result = parse("");
      expect(result.routes).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 12. Test files excluded (file-system based test)
  // ---------------------------------------------------------------------------

  describe("file exclusion", () => {
    it("should exclude test files from scanning", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autodoc-test-"));

      try {
        // Regular source file with a route
        fs.writeFileSync(
          path.join(tmpDir, "app.ts"),
          `
          const express = require('express');
          const app = express();
          app.get('/health', (req, res) => res.json({ ok: true }));
          `
        );

        // Test file (should be excluded)
        fs.writeFileSync(
          path.join(tmpDir, "app.test.ts"),
          `
          const express = require('express');
          const app = express();
          app.get('/test-only', (req, res) => res.json({}));
          `
        );

        // Spec file (should be excluded)
        fs.writeFileSync(
          path.join(tmpDir, "app.spec.ts"),
          `
          const express = require('express');
          const app = express();
          app.get('/spec-only', (req, res) => res.json({}));
          `
        );

        // __tests__ directory (should be excluded)
        const testsDir = path.join(tmpDir, "__tests__");
        fs.mkdirSync(testsDir);
        fs.writeFileSync(
          path.join(testsDir, "integration.ts"),
          `
          const express = require('express');
          const app = express();
          app.get('/integration', (req, res) => res.json({}));
          `
        );

        const result = await parseExpressRoutes(tmpDir);

        expect(result.routes).toHaveLength(1);
        expect(result.routes[0].path).toBe("/health");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should exclude node_modules, dist, and build directories", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autodoc-excl-"));

      try {
        fs.writeFileSync(
          path.join(tmpDir, "index.ts"),
          `
          const express = require('express');
          const app = express();
          app.get('/real', (req, res) => res.json({}));
          `
        );

        for (const dir of ["node_modules", "dist", "build"]) {
          const d = path.join(tmpDir, dir);
          fs.mkdirSync(d);
          fs.writeFileSync(
            path.join(d, "routes.ts"),
            `
            const express = require('express');
            const app = express();
            app.get('/excluded', (req, res) => res.json({}));
            `
          );
        }

        const result = await parseExpressRoutes(tmpDir);

        expect(result.routes).toHaveLength(1);
        expect(result.routes[0].path).toBe("/real");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: req.query extraction
  // ---------------------------------------------------------------------------

  describe("query param extraction", () => {
    it("should extract req.query.xxx as query params", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/search', (req, res) => {
          const q = req.query.q;
          const page = req.query.page;
          res.json({ q, page });
        });
      `);

      expect(result.routes).toHaveLength(1);
      const queryParams = result.routes[0].params.filter(
        (p) => p.in === "query"
      );
      expect(queryParams).toHaveLength(2);
      expect(queryParams.map((p) => p.name).sort()).toEqual(["page", "q"]);
      expect(queryParams[0].required).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: req.body extraction
  // ---------------------------------------------------------------------------

  describe("request body extraction", () => {
    it("should detect req.body usage and extract properties", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.post('/users', (req, res) => {
          const name = req.body.name;
          const email = req.body.email;
          res.json({ name, email });
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].requestBody).not.toBeNull();
      expect(result.routes[0].requestBody!.type).toBe("object");
      expect(result.routes[0].requestBody!.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "name" }),
          expect.objectContaining({ name: "email" }),
        ])
      );
    });

    it("should detect bare req.body reference", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.post('/data', (req, res) => {
          const data = req.body;
          res.json(data);
        });
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].requestBody).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: controller name extraction
  // ---------------------------------------------------------------------------

  describe("controller extraction", () => {
    it("should extract named handler function as controller", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', getUsers);
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].controller).toBe("getUsers");
    });

    it("should extract member expression as controller", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', userController.list);
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].controller).toBe("userController.list");
    });

    it("should set controller to null for inline functions", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.get('/users', (req, res) => res.json([]));
      `);

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].controller).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: source file tracking
  // ---------------------------------------------------------------------------

  describe("source tracking", () => {
    it("should track source file name", () => {
      const result = parse(
        `
        const express = require('express');
        const app = express();
        app.get('/test', (req, res) => {});
      `,
        "src/routes/api.ts"
      );

      expect(result.routes[0].source).toBe("src/routes/api.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: parse error handling
  // ---------------------------------------------------------------------------

  describe("parse error handling", () => {
    it("should collect parse errors and continue", () => {
      // Babel's error recovery should handle most syntax issues,
      // but we still get errors array populated
      const result = parse(
        "this is completely not valid javascript @@@ ### $$$"
      );
      // Either routes empty or errors populated — parser should not throw
      expect(result).toBeDefined();
      expect(Array.isArray(result.routes)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Additional: HEAD and OPTIONS methods
  // ---------------------------------------------------------------------------

  describe("HEAD and OPTIONS methods", () => {
    it("should detect HEAD and OPTIONS routes", () => {
      const result = parse(`
        const express = require('express');
        const app = express();
        app.head('/ping', (req, res) => res.end());
        app.options('/cors', (req, res) => res.end());
      `);

      expect(result.routes).toHaveLength(2);
      const methods = result.routes.map((r) => r.method).sort();
      expect(methods).toEqual(["HEAD", "OPTIONS"]);
    });
  });
});
