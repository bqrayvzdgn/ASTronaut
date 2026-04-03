import fs from "fs";
import path from "path";
import * as babelParser from "@babel/parser";
import _traverse from "@babel/traverse";
import type { Node, Comment } from "@babel/types";
import {
  ParseResult,
  RouteInfo,
  ParseError,
  HttpMethod,
  ParamInfo,
  RequestBodyInfo,
  PropertyInfo,
} from "./types";
import { logger } from "../utils/logger";

const traverse: typeof _traverse =
  typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS: Set<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "test",
  "__tests__",
]);

const BABEL_PLUGINS: babelParser.ParserPlugin[] = [
  "typescript",
  "jsx",
  "decorators-legacy",
  "classProperties",
  "optionalChaining",
  "nullishCoalescingOperator",
];

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

type RouterType = "app" | "pages";

interface NextRouteFile {
  filePath: string;
  routerType: RouterType;
  routePath: string;
}

/**
 * Find Next.js API route files in the repo.
 * Supports both App Router and Pages Router.
 */
function discoverNextRouteFiles(rootDir: string): NextRouteFile[] {
  const results: NextRouteFile[] = [];

  // Possible root prefixes: root, src/
  const prefixes = ["", "src/"];

  for (const prefix of prefixes) {
    // App Router: app/**/route.ts|js
    const appDir = path.join(rootDir, prefix, "app");
    if (fs.existsSync(appDir)) {
      walkAppRouter(appDir, appDir, results);
    }

    // Pages Router: pages/api/**/*.ts|js
    const pagesApiDir = path.join(rootDir, prefix, "pages", "api");
    if (fs.existsSync(pagesApiDir)) {
      walkPagesRouter(pagesApiDir, pagesApiDir, results);
    }
  }

  return results;
}

function walkAppRouter(
  dir: string,
  appRoot: string,
  results: NextRouteFile[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walkAppRouter(path.join(dir, entry.name), appRoot, results);
      }
    } else if (entry.isFile()) {
      const name = entry.name;
      // Only route.ts, route.js, route.tsx, route.jsx
      if (/^route\.(ts|js|tsx|jsx)$/.test(name)) {
        const filePath = path.join(dir, name);
        const relativeDirPath = path.relative(appRoot, dir).replace(/\\/g, "/");
        const routePath = filePathToRoutePath(relativeDirPath, "app");

        // Only include routes under /api
        if (routePath.startsWith("/api")) {
          results.push({ filePath, routerType: "app", routePath });
        }
      }
    }
  }
}

function walkPagesRouter(
  dir: string,
  pagesApiRoot: string,
  results: NextRouteFile[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walkPagesRouter(path.join(dir, entry.name), pagesApiRoot, results);
      }
    } else if (entry.isFile()) {
      const name = entry.name;
      if (
        (name.endsWith(".ts") || name.endsWith(".js") ||
         name.endsWith(".tsx") || name.endsWith(".jsx")) &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".test.js") &&
        !name.endsWith(".spec.ts") &&
        !name.endsWith(".spec.js") &&
        !name.endsWith(".d.ts")
      ) {
        const filePath = path.join(dir, name);
        const relativeFilePath = path
          .relative(pagesApiRoot, filePath)
          .replace(/\\/g, "/");
        const routePath = filePathToRoutePath(relativeFilePath, "pages");
        results.push({ filePath, routerType: "pages", routePath });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File path → Route path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a file/directory path to an API route path.
 *
 * App Router:  "api/users/[id]"     → "/api/users/:id"
 * Pages Router: "users/[id].ts"     → "/api/users/:id"
 */
function filePathToRoutePath(relativePath: string, routerType: RouterType): string {
  let segments: string[];

  if (routerType === "pages") {
    // Remove file extension
    const withoutExt = relativePath.replace(/\.(ts|js|tsx|jsx)$/, "");
    segments = withoutExt.split("/");
    // Remove trailing "index"
    if (segments.length > 0 && segments[segments.length - 1] === "index") {
      segments.pop();
    }
    // Prepend /api since pages/api/ is the root
    segments = ["api", ...segments];
  } else {
    // App Router: relativePath is the directory path from app root
    segments = relativePath.split("/").filter((s) => s !== "");
  }

  // Transform segments
  const transformed = segments
    .filter((s) => s !== "")
    .map((segment) => {
      // Strip route groups: (admin) → skip
      if (/^\(.*\)$/.test(segment)) {
        return null;
      }
      // Catch-all: [...slug] → :slug*
      if (/^\[\.\.\.(\w+)\]$/.test(segment)) {
        const match = segment.match(/^\[\.\.\.(\w+)\]$/);
        return `:${match![1]}*`;
      }
      // Optional catch-all: [[...slug]] → :slug*
      if (/^\[\[\.\.\.(\w+)\]\]$/.test(segment)) {
        const match = segment.match(/^\[\[\.\.\.(\w+)\]\]$/);
        return `:${match![1]}*`;
      }
      // Dynamic segment: [id] → :id
      if (/^\[(\w+)\]$/.test(segment)) {
        const match = segment.match(/^\[(\w+)\]$/);
        return `:${match![1]}`;
      }
      return segment;
    })
    .filter((s): s is string => s !== null);

  return "/" + transformed.join("/");
}

/**
 * Extract path params from a converted route path (e.g. /api/users/:id).
 */
function extractPathParams(routePath: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  const regex = /:([a-zA-Z_]\w*)(\*)?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(routePath)) !== null) {
    params.push({
      name: match[1],
      in: "path",
      type: match[2] ? "string[]" : "string",
      required: true,
    });
  }
  return params;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parseCode(code: string, fileName: string): any | null {
  try {
    return babelParser.parse(code, {
      sourceType: "module",
      plugins: BABEL_PLUGINS,
      errorRecovery: true,
    });
  } catch {
    return null;
  }
}

function getLeadingJSDoc(node: Node): string | null {
  const comments: Comment[] | undefined | null = (node as any).leadingComments;
  if (!comments || comments.length === 0) return null;

  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.type === "CommentBlock" && c.value.startsWith("*")) {
      const cleaned = c.value
        .replace(/^\*\s?/gm, "")
        .replace(/\n\s*\*/g, "\n")
        .replace(/^\s+|\s+$/g, "")
        .trim();
      return cleaned || null;
    }
  }
  return null;
}

function wrapInProgram(node: Node): any {
  return {
    type: "File",
    program: {
      type: "Program",
      sourceType: "module",
      body: [
        {
          type: "ExpressionStatement",
          expression: node,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// App Router parser: extract named exports (GET, POST, etc.)
// ---------------------------------------------------------------------------

function parseAppRouterFile(
  code: string,
  routePath: string,
  source: string
): { routes: RouteInfo[]; errors: ParseError[] } {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];

  const ast = parseCode(code, source);
  if (!ast) {
    errors.push({ file: source, reason: "Failed to parse file" });
    return { routes, errors };
  }

  const pathParams = extractPathParams(routePath);

  traverse(ast, {
    // export async function GET(request) { ... }
    ExportNamedDeclaration(p: any) {
      const decl = p.node.declaration;
      if (!decl) return;

      if (decl.type === "FunctionDeclaration" && decl.id?.name) {
        const method = decl.id.name.toUpperCase();
        if (!HTTP_METHODS.has(method)) return;

        const description = getLeadingJSDoc(p.node) || getLeadingJSDoc(decl);
        const requestBody = extractAppRouterBody(decl);
        const queryParams = extractAppRouterSearchParams(decl);

        routes.push({
          path: routePath,
          method: method as HttpMethod,
          controller: decl.id.name,
          routePrefix: null,
          params: [...pathParams, ...queryParams],
          requestBody,
          responses: [],
          auth: null,
          middleware: [],
          description,
          source,
        });
      }

      // export const GET = async (request) => { ... }
      if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type !== "Identifier") continue;
          const method = declarator.id.name.toUpperCase();
          if (!HTTP_METHODS.has(method)) continue;

          const init = declarator.init;
          if (!init) continue;

          // Arrow function or function expression
          const fnNode =
            init.type === "ArrowFunctionExpression" ||
            init.type === "FunctionExpression"
              ? init
              : null;

          const description = getLeadingJSDoc(p.node) || getLeadingJSDoc(decl);
          const requestBody = fnNode ? extractAppRouterBody(fnNode) : null;
          const queryParams = fnNode ? extractAppRouterSearchParams(fnNode) : [];

          routes.push({
            path: routePath,
            method: method as HttpMethod,
            controller: declarator.id.name,
            routePrefix: null,
            params: [...pathParams, ...queryParams],
            requestBody,
            responses: [],
            auth: null,
            middleware: [],
            description,
            source,
          });
        }
      }
    },
  });

  return { routes, errors };
}

/**
 * Detect request.json() calls in App Router handler body.
 */
function extractAppRouterBody(fnNode: Node): RequestBodyInfo | null {
  let hasBody = false;

  traverse(
    wrapInProgram(fnNode),
    {
      CallExpression(innerPath: any) {
        const node = innerPath.node;
        // request.json() or req.json()
        if (
          node.callee?.type === "MemberExpression" &&
          node.callee.property?.type === "Identifier" &&
          node.callee.property.name === "json" &&
          node.callee.object?.type === "Identifier"
        ) {
          hasBody = true;
        }
        // (await request.json()) pattern — already caught by above
      },
    },
    undefined,
    { noScope: true }
  );

  return hasBody ? { type: "object", properties: [] } : null;
}

/**
 * Detect searchParams / nextUrl.searchParams usage in App Router.
 */
function extractAppRouterSearchParams(fnNode: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  const seen = new Set<string>();

  traverse(
    wrapInProgram(fnNode),
    {
      CallExpression(innerPath: any) {
        const node = innerPath.node;
        // searchParams.get('name') or request.nextUrl.searchParams.get('name')
        if (
          node.callee?.type === "MemberExpression" &&
          node.callee.property?.type === "Identifier" &&
          node.callee.property.name === "get" &&
          node.arguments?.length >= 1 &&
          node.arguments[0].type === "StringLiteral"
        ) {
          // Check if the object involves searchParams
          if (isSearchParamsAccess(node.callee.object)) {
            const paramName = node.arguments[0].value;
            if (!seen.has(paramName)) {
              seen.add(paramName);
              params.push({
                name: paramName,
                in: "query",
                type: "string",
                required: false,
              });
            }
          }
        }
      },
    },
    undefined,
    { noScope: true }
  );

  return params;
}

function isSearchParamsAccess(node: any): boolean {
  if (!node) return false;
  // searchParams (direct variable)
  if (node.type === "Identifier" && node.name === "searchParams") return true;
  // *.searchParams
  if (
    node.type === "MemberExpression" &&
    node.property?.type === "Identifier" &&
    node.property.name === "searchParams"
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pages Router parser: detect methods from default export handler
// ---------------------------------------------------------------------------

function parsePagesRouterFile(
  code: string,
  routePath: string,
  source: string
): { routes: RouteInfo[]; errors: ParseError[] } {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];

  const ast = parseCode(code, source);
  if (!ast) {
    errors.push({ file: source, reason: "Failed to parse file" });
    return { routes, errors };
  }

  const pathParams = extractPathParams(routePath);

  // Find the default export handler function
  let handlerNode: any = null;
  let handlerDescription: string | null = null;

  traverse(ast, {
    ExportDefaultDeclaration(p: any) {
      const decl = p.node.declaration;
      handlerDescription = getLeadingJSDoc(p.node);

      if (
        decl.type === "FunctionDeclaration" ||
        decl.type === "ArrowFunctionExpression" ||
        decl.type === "FunctionExpression"
      ) {
        handlerNode = decl;
      } else if (decl.type === "Identifier") {
        // export default handler — need to find the handler declaration
        const name = decl.name;
        // Look for function declaration or variable with that name
        p.scope?.path?.traverse({
          FunctionDeclaration(fp: any) {
            if (fp.node.id?.name === name) {
              handlerNode = fp.node;
            }
          },
          VariableDeclarator(vp: any) {
            if (
              vp.node.id?.type === "Identifier" &&
              vp.node.id.name === name &&
              (vp.node.init?.type === "ArrowFunctionExpression" ||
                vp.node.init?.type === "FunctionExpression")
            ) {
              handlerNode = vp.node.init;
            }
          },
        });
      }
    },
  });

  if (!handlerNode) {
    errors.push({
      file: source,
      reason: "No default export handler found",
    });
    return { routes, errors };
  }

  // Detect methods from req.method checks
  const methods = extractMethodsFromHandler(handlerNode);

  // Extract query params and body
  const queryParams = extractPagesQueryParams(handlerNode);
  const requestBody = extractPagesRequestBody(handlerNode);

  // Get handler name
  const controller = handlerNode.id?.name ?? null;

  if (methods.length === 0) {
    // No method checks found — treat as handling all methods (default: GET)
    routes.push({
      path: routePath,
      method: "GET",
      controller,
      routePrefix: null,
      params: [...pathParams, ...queryParams],
      requestBody,
      responses: [],
      auth: null,
      middleware: [],
      description: handlerDescription,
      source,
    });
  } else {
    for (const method of methods) {
      // Only attach body for methods that use it
      const methodBody =
        method === "POST" || method === "PUT" || method === "PATCH"
          ? requestBody
          : null;

      routes.push({
        path: routePath,
        method,
        controller,
        routePrefix: null,
        params: [...pathParams, ...queryParams],
        requestBody: methodBody,
        responses: [],
        auth: null,
        middleware: [],
        description: handlerDescription,
        source,
      });
    }
  }

  return { routes, errors };
}

/**
 * Extract HTTP methods from `req.method === 'GET'` or `req.method === 'POST'` checks.
 */
function extractMethodsFromHandler(handlerNode: Node): HttpMethod[] {
  const methods = new Set<HttpMethod>();

  traverse(
    wrapInProgram(handlerNode),
    {
      // req.method === 'GET'
      BinaryExpression(innerPath: any) {
        const node = innerPath.node;
        if (node.operator !== "===" && node.operator !== "==") return;

        const isMethodLeft = isReqMethodAccess(node.left);
        const isMethodRight = isReqMethodAccess(node.right);

        if (isMethodLeft && node.right?.type === "StringLiteral") {
          const m = node.right.value.toUpperCase();
          if (HTTP_METHODS.has(m)) methods.add(m as HttpMethod);
        }
        if (isMethodRight && node.left?.type === "StringLiteral") {
          const m = node.left.value.toUpperCase();
          if (HTTP_METHODS.has(m)) methods.add(m as HttpMethod);
        }
      },
      // switch (req.method) { case 'GET': ... }
      SwitchStatement(innerPath: any) {
        const node = innerPath.node;
        if (!isReqMethodAccess(node.discriminant)) return;

        for (const c of node.cases) {
          if (c.test?.type === "StringLiteral") {
            const m = c.test.value.toUpperCase();
            if (HTTP_METHODS.has(m)) methods.add(m as HttpMethod);
          }
        }
      },
    },
    undefined,
    { noScope: true }
  );

  return Array.from(methods);
}

function isReqMethodAccess(node: any): boolean {
  return (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    node.object.name === "req" &&
    node.property?.type === "Identifier" &&
    node.property.name === "method"
  );
}

/**
 * Extract query params from `req.query.xxx` in Pages Router.
 */
function extractPagesQueryParams(handlerNode: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  const seen = new Set<string>();

  traverse(
    wrapInProgram(handlerNode),
    {
      MemberExpression(innerPath: any) {
        const node = innerPath.node;
        if (
          node.object?.type === "MemberExpression" &&
          node.object.object?.type === "Identifier" &&
          node.object.object.name === "req" &&
          node.object.property?.type === "Identifier" &&
          node.object.property.name === "query"
        ) {
          let paramName: string | null = null;
          if (node.property.type === "Identifier") {
            paramName = node.property.name;
          } else if (node.property.type === "StringLiteral") {
            paramName = node.property.value;
          }
          if (paramName && !seen.has(paramName)) {
            seen.add(paramName);
            params.push({
              name: paramName,
              in: "query",
              type: "string",
              required: false,
            });
          }
        }
      },
    },
    undefined,
    { noScope: true }
  );

  return params;
}

/**
 * Extract request body from `req.body` in Pages Router.
 */
function extractPagesRequestBody(handlerNode: Node): RequestBodyInfo | null {
  const properties: PropertyInfo[] = [];
  const seen = new Set<string>();
  let hasBody = false;

  traverse(
    wrapInProgram(handlerNode),
    {
      MemberExpression(innerPath: any) {
        const node = innerPath.node;
        if (
          node.object?.type === "Identifier" &&
          node.object.name === "req" &&
          node.property?.type === "Identifier" &&
          node.property.name === "body"
        ) {
          hasBody = true;
        }
        if (
          node.object?.type === "MemberExpression" &&
          node.object.object?.type === "Identifier" &&
          node.object.object.name === "req" &&
          node.object.property?.type === "Identifier" &&
          node.object.property.name === "body"
        ) {
          let propName: string | null = null;
          if (node.property.type === "Identifier") {
            propName = node.property.name;
          } else if (node.property.type === "StringLiteral") {
            propName = node.property.value;
          }
          if (propName && !seen.has(propName)) {
            seen.add(propName);
            properties.push({
              name: propName,
              type: "any",
              required: false,
            });
          }
        }
      },
      // const { name, email } = req.body
      VariableDeclarator(innerPath: any) {
        const node = innerPath.node;
        if (
          node.id?.type === "ObjectPattern" &&
          node.init?.type === "MemberExpression" &&
          node.init.object?.type === "Identifier" &&
          node.init.object.name === "req" &&
          node.init.property?.type === "Identifier" &&
          node.init.property.name === "body"
        ) {
          hasBody = true;
          for (const prop of node.id.properties) {
            if (
              prop.type === "ObjectProperty" &&
              prop.key?.type === "Identifier"
            ) {
              const propName = prop.key.name;
              if (!seen.has(propName)) {
                seen.add(propName);
                properties.push({
                  name: propName,
                  type: "any",
                  required: false,
                });
              }
            }
          }
        }
      },
    },
    undefined,
    { noScope: true }
  );

  if (!hasBody && properties.length === 0) return null;
  return { type: "object", properties };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseNextRoutes(
  rootDir: string
): Promise<ParseResult> {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];

  const routeFiles = discoverNextRouteFiles(rootDir);
  logger.info(
    { fileCount: routeFiles.length, rootDir },
    "Scanning Next.js API routes"
  );

  for (const routeFile of routeFiles) {
    try {
      const code = fs.readFileSync(routeFile.filePath, "utf-8");
      const relativePath = path
        .relative(rootDir, routeFile.filePath)
        .replace(/\\/g, "/");

      const result =
        routeFile.routerType === "app"
          ? parseAppRouterFile(code, routeFile.routePath, relativePath)
          : parsePagesRouterFile(code, routeFile.routePath, relativePath);

      routes.push(...result.routes);
      errors.push(...result.errors);
    } catch (err: any) {
      errors.push({
        file: path.relative(rootDir, routeFile.filePath).replace(/\\/g, "/"),
        reason: `Failed to read file: ${err.message ?? err}`,
      });
    }
  }

  logger.info(
    { routeCount: routes.length, errorCount: errors.length },
    "Next.js route parsing complete"
  );

  return { routes, errors };
}

/**
 * Parse an in-memory source string. Useful for testing.
 */
export function parseNextSource(
  code: string,
  filePath: string,
  routerType: RouterType
): ParseResult {
  const routePath = filePathToRoutePath(
    filePath,
    routerType
  );
  const result =
    routerType === "app"
      ? parseAppRouterFile(code, routePath, filePath)
      : parsePagesRouterFile(code, routePath, filePath);
  return { routes: result.routes, errors: result.errors };
}

// Export for testing
export { filePathToRoutePath };
