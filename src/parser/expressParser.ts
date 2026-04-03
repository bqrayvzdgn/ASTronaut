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

// @babel/traverse ships as { default: traverseFn } under CJS
const traverse: typeof _traverse =
  typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

const AUTH_KEYWORDS = [
  "auth",
  "guard",
  "protect",
  "verify",
  "jwt",
  "passport",
  "token",
];

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "test",
  "__tests__",
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectSourceFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (
          (name.endsWith(".ts") || name.endsWith(".js")) &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".test.js") &&
          !name.endsWith(".spec.ts") &&
          !name.endsWith(".spec.js") &&
          !name.endsWith(".d.ts")
        ) {
          results.push(path.join(dir, name));
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthMiddleware(name: string): boolean {
  const lower = name.toLowerCase();
  return AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

function extractPathParams(routePath: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(routePath)) !== null) {
    params.push({
      name: match[1],
      in: "path",
      type: "string",
      required: true,
    });
  }
  return params;
}

function getLeadingJSDoc(node: Node): string | null {
  const comments: Comment[] | undefined | null =
    (node as any).leadingComments;
  if (!comments || comments.length === 0) return null;

  // Take the last leading comment that looks like JSDoc
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.type === "CommentBlock" && c.value.startsWith("*")) {
      // Strip the typical JSDoc formatting
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

/** Get the name of a callee from a MemberExpression or Identifier */
function getCalleeName(node: any): { object: string; property: string } | null {
  if (
    node.type === "MemberExpression" &&
    node.object &&
    node.property
  ) {
    const objName =
      node.object.type === "Identifier" ? node.object.name : null;
    const propName =
      node.property.type === "Identifier" ? node.property.name : null;
    if (objName && propName) return { object: objName, property: propName };
  }
  return null;
}

/**
 * Walk a function body AST to find `req.query.xxx` or `req.query['xxx']` usages.
 */
function extractQueryParams(handlerNode: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  const seen = new Set<string>();

  traverse(
    wrapInProgram(handlerNode),
    {
      MemberExpression(innerPath: any) {
        const node = innerPath.node;
        // req.query.xxx
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
          } else if (
            node.property.type === "StringLiteral"
          ) {
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
    { noScope: true },
  );

  return params;
}

/**
 * Detect req.body usage in handler and build a RequestBodyInfo.
 */
function extractRequestBody(handlerNode: Node): RequestBodyInfo | null {
  const properties: PropertyInfo[] = [];
  const seen = new Set<string>();
  let hasBody = false;

  traverse(
    wrapInProgram(handlerNode),
    {
      MemberExpression(innerPath: any) {
        const node = innerPath.node;
        // req.body
        if (
          node.object?.type === "Identifier" &&
          node.object.name === "req" &&
          node.property?.type === "Identifier" &&
          node.property.name === "body"
        ) {
          hasBody = true;
        }
        // req.body.xxx
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
    },
    undefined,
    { noScope: true },
  );

  if (!hasBody && properties.length === 0) return null;
  return { type: "object", properties };
}

/**
 * Wrap a node in a minimal Program so `traverse` can walk it.
 */
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
// TypeScript type extraction helpers
// ---------------------------------------------------------------------------

interface TypeDefs {
  [name: string]: PropertyInfo[];
}

/**
 * Collect top-level interface and type alias definitions from the AST.
 */
function collectTypeDefs(ast: any): TypeDefs {
  const defs: TypeDefs = {};

  traverse(ast, {
    TSInterfaceDeclaration(p: any) {
      const name = p.node.id?.name;
      if (!name) return;
      defs[name] = extractPropertiesFromTSBody(p.node.body);
    },
    TSTypeAliasDeclaration(p: any) {
      const name = p.node.id?.name;
      if (!name) return;
      if (p.node.typeAnnotation?.type === "TSTypeLiteral") {
        defs[name] = extractPropertiesFromTSTypeLiteral(
          p.node.typeAnnotation
        );
      }
    },
  });

  return defs;
}

function extractPropertiesFromTSBody(body: any): PropertyInfo[] {
  if (!body?.body) return [];
  return body.body
    .filter((m: any) => m.type === "TSPropertySignature")
    .map((m: any) => ({
      name:
        m.key?.type === "Identifier"
          ? m.key.name
          : m.key?.value ?? "unknown",
      type: tsTypeToString(m.typeAnnotation?.typeAnnotation),
      required: !m.optional,
    }));
}

function extractPropertiesFromTSTypeLiteral(literal: any): PropertyInfo[] {
  if (!literal?.members) return [];
  return literal.members
    .filter((m: any) => m.type === "TSPropertySignature")
    .map((m: any) => ({
      name:
        m.key?.type === "Identifier"
          ? m.key.name
          : m.key?.value ?? "unknown",
      type: tsTypeToString(m.typeAnnotation?.typeAnnotation),
      required: !m.optional,
    }));
}

function tsTypeToString(typeNode: any): string {
  if (!typeNode) return "any";
  switch (typeNode.type) {
    case "TSStringKeyword":
      return "string";
    case "TSNumberKeyword":
      return "number";
    case "TSBooleanKeyword":
      return "boolean";
    case "TSAnyKeyword":
      return "any";
    case "TSVoidKeyword":
      return "void";
    case "TSNullKeyword":
      return "null";
    case "TSUndefinedKeyword":
      return "undefined";
    case "TSArrayType":
      return tsTypeToString(typeNode.elementType) + "[]";
    case "TSTypeReference":
      return typeNode.typeName?.name ?? "any";
    case "TSUnionType":
      return typeNode.types.map(tsTypeToString).join(" | ");
    case "TSLiteralType":
      return String(typeNode.literal?.value ?? "any");
    default:
      return "any";
  }
}

/**
 * Extract param types from Request<Params, ResBody, ReqBody, ReqQuery> generic.
 */
function extractTypedParams(
  handlerNode: any,
  typeDefs: TypeDefs
): { pathParams: ParamInfo[]; queryParams: ParamInfo[]; body: RequestBodyInfo | null } {
  const result: {
    pathParams: ParamInfo[];
    queryParams: ParamInfo[];
    body: RequestBodyInfo | null;
  } = { pathParams: [], queryParams: [], body: null };

  // Find the first parameter that has a type annotation referencing Request<...>
  const params: any[] = handlerNode.params ?? [];
  for (const param of params) {
    const annotation = param.typeAnnotation?.typeAnnotation;
    if (
      annotation?.type === "TSTypeReference" &&
      annotation.typeName?.name === "Request" &&
      annotation.typeParameters?.params?.length
    ) {
      const typeArgs = annotation.typeParameters.params;

      // First type param = Params (path params)
      if (typeArgs[0]) {
        const pathProps = resolveTypeToProperties(typeArgs[0], typeDefs);
        result.pathParams = pathProps.map((p) => ({
          name: p.name,
          in: "path" as const,
          type: p.type,
          required: p.required,
        }));
      }

      // Third type param = ReqBody
      if (typeArgs[2]) {
        const bodyProps = resolveTypeToProperties(typeArgs[2], typeDefs);
        if (bodyProps.length > 0) {
          result.body = { type: "object", properties: bodyProps };
        }
      }

      // Fourth type param = ReqQuery
      if (typeArgs[3]) {
        const queryProps = resolveTypeToProperties(typeArgs[3], typeDefs);
        result.queryParams = queryProps.map((p) => ({
          name: p.name,
          in: "query" as const,
          type: p.type,
          required: p.required,
        }));
      }

      break;
    }
  }

  return result;
}

function resolveTypeToProperties(
  typeNode: any,
  typeDefs: TypeDefs
): PropertyInfo[] {
  if (!typeNode) return [];

  if (typeNode.type === "TSTypeLiteral") {
    return extractPropertiesFromTSTypeLiteral(typeNode);
  }

  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.name
  ) {
    const name = typeNode.typeName.name;
    return typeDefs[name] ?? [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export async function parseExpressRoutes(
  rootDir: string
): Promise<ParseResult> {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];

  const files = collectSourceFiles(rootDir);
  logger.info({ fileCount: files.length, rootDir }, "Scanning Express routes");

  // Pre-scan: build cross-file mount map (import var → source file, mount prefix)
  const mountMap = buildMountMap(rootDir, files);

  for (const filePath of files) {
    try {
      const code = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
      parseFile(code, relativePath, routes, errors);
    } catch (err: any) {
      errors.push({
        file: path.relative(rootDir, filePath).replace(/\\/g, "/"),
        reason: `Failed to read file: ${err.message ?? err}`,
      });
    }
  }

  // Post-process: apply mount prefixes to routes from imported files
  applyMountPrefixes(routes, mountMap);

  logger.info(
    { routeCount: routes.length, errorCount: errors.length },
    "Express route parsing complete"
  );

  return { routes, errors };
}

/**
 * Resolve a require/import path to an actual file path.
 */
function resolveModulePath(
  importPath: string,
  fromFile: string,
  rootDir: string
): string | null {
  if (!importPath.startsWith(".")) return null; // skip node_modules

  const fromDir = path.dirname(path.join(rootDir, fromFile));
  const candidates = [
    path.resolve(fromDir, importPath),
    path.resolve(fromDir, importPath + ".ts"),
    path.resolve(fromDir, importPath + ".js"),
    path.resolve(fromDir, importPath, "index.ts"),
    path.resolve(fromDir, importPath, "index.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(rootDir, candidate).replace(/\\/g, "/");
    }
  }
  return null;
}

interface MountInfo {
  prefix: string;
  sourceFile: string; // relative path of the file containing the routes
}

/**
 * Pre-scan files to find app.use('/prefix', importedRouter) patterns
 * and resolve import paths to actual file paths.
 */
function buildMountMap(
  rootDir: string,
  files: string[]
): MountInfo[] {
  const mounts: MountInfo[] = [];

  for (const filePath of files) {
    let code: string;
    try {
      code = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");

    let ast: any;
    try {
      ast = babelParser.parse(code, {
        sourceType: "module",
        plugins: ["typescript", "decorators-legacy", "jsx"],
      });
    } catch {
      continue;
    }

    // Track: importVar → relative module path
    const importMap = new Map<string, string>();

    traverse(ast, {
      // const userRouter = require('./routes/users')
      VariableDeclarator(p: any) {
        const init = p.node.init;
        const id = p.node.id;
        if (!init || id?.type !== "Identifier") return;

        if (
          init.type === "CallExpression" &&
          init.callee?.type === "Identifier" &&
          init.callee.name === "require" &&
          init.arguments?.[0]?.type === "StringLiteral"
        ) {
          const resolved = resolveModulePath(
            init.arguments[0].value,
            relativePath,
            rootDir
          );
          if (resolved) importMap.set(id.name, resolved);
        }
      },

      // import userRouter from './routes/users'
      ImportDeclaration(p: any) {
        const source = p.node.source?.value;
        if (!source) return;
        const resolved = resolveModulePath(source, relativePath, rootDir);
        if (!resolved) return;

        for (const spec of p.node.specifiers ?? []) {
          if (spec.local?.type === "Identifier") {
            importMap.set(spec.local.name, resolved);
          }
        }
      },
    });

    // Find app.use('/prefix', importedVar) patterns
    traverse(ast, {
      CallExpression(p: any) {
        const callee = p.node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.property?.type !== "Identifier" ||
          callee.property.name !== "use"
        ) {
          return;
        }

        const args = p.node.arguments;
        if (
          args.length >= 2 &&
          args[0].type === "StringLiteral" &&
          args[args.length - 1].type === "Identifier"
        ) {
          const prefix = args[0].value;
          const varName = args[args.length - 1].name;
          const sourceFile = importMap.get(varName);
          if (sourceFile) {
            mounts.push({ prefix, sourceFile });
          }
        }
      },
    });
  }

  return mounts;
}

/**
 * Apply mount prefixes to routes parsed from imported files.
 * Routes from a mounted file get the mount prefix prepended to their path.
 */
function applyMountPrefixes(
  routes: RouteInfo[],
  mounts: MountInfo[]
): void {
  if (mounts.length === 0) return;

  // Build source file → prefix map
  const prefixBySource = new Map<string, string>();
  for (const mount of mounts) {
    // If multiple mounts for same file, use the first one
    if (!prefixBySource.has(mount.sourceFile)) {
      prefixBySource.set(mount.sourceFile, mount.prefix);
    }
  }

  for (const route of routes) {
    const prefix = prefixBySource.get(route.source);
    if (prefix && !route.path.startsWith(prefix)) {
      // Avoid double slashes
      const cleanPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      const cleanPath = route.path.startsWith("/") ? route.path : "/" + route.path;
      route.path = cleanPrefix + cleanPath;

      // Also set routePrefix if not already set
      if (!route.routePrefix) {
        route.routePrefix = prefix;
      }
    }
  }
}

/**
 * Parse an in-memory source string. Useful for testing.
 */
export function parseExpressSource(
  code: string,
  fileName: string = "source.ts"
): ParseResult {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];
  parseFile(code, fileName, routes, errors);
  return { routes, errors };
}

// ---------------------------------------------------------------------------
// Core file-level parser
// ---------------------------------------------------------------------------

function parseFile(
  code: string,
  fileName: string,
  routes: RouteInfo[],
  errors: ParseError[]
): void {
  let ast: any;
  try {
    ast = babelParser.parse(code, {
      sourceType: "module",
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
        "optionalChaining",
        "nullishCoalescingOperator",
      ],
      errorRecovery: true,
    });
  } catch (err: any) {
    errors.push({
      file: fileName,
      reason: `Parse error: ${err.message ?? err}`,
    });
    return;
  }

  // Collect TypeScript type definitions from this file
  const typeDefs = collectTypeDefs(ast);

  // Track router variable names (e.g. const router = express.Router())
  const routerVars = new Set<string>();
  // Track app variable names (e.g. const app = express())
  const appVars = new Set<string>();
  // Router prefix mapping: variable name → prefix
  const routerPrefixes: Map<string, string> = new Map();
  // Global auth middleware (app.use(authMw))
  const globalAuth: string[] = [];
  // Router-level auth: router variable → auth name
  const routerAuth: Map<string, string[]> = new Map();
  // Global middleware
  const globalMiddleware: string[] = [];
  // Router-level middleware
  const routerMiddleware: Map<string, string[]> = new Map();

  // First pass: identify router/app variables and global middleware
  traverse(ast, {
    VariableDeclarator(p: any) {
      const init = p.node.init;
      const id = p.node.id;
      if (!init || id?.type !== "Identifier") return;

      // express() call → app variable
      if (
        init.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "express"
      ) {
        appVars.add(id.name);
      }

      // express.Router() call → router variable
      if (
        init.type === "CallExpression" &&
        init.callee?.type === "MemberExpression" &&
        init.callee.object?.type === "Identifier" &&
        init.callee.object.name === "express" &&
        init.callee.property?.type === "Identifier" &&
        init.callee.property.name === "Router"
      ) {
        routerVars.add(id.name);
      }

      // Router() or require('express').Router()
      if (
        init.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "Router"
      ) {
        routerVars.add(id.name);
      }

      // new Router() pattern (rare but possible)
      if (
        init.type === "NewExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "Router"
      ) {
        routerVars.add(id.name);
      }
    },

    CallExpression(p: any) {
      const node = p.node;
      const callee = getCalleeName(node.callee);
      if (!callee) return;

      // app.use() or router.use()
      if (callee.property !== "use") return;
      const isApp =
        appVars.has(callee.object) || callee.object === "app";
      const isRouter =
        routerVars.has(callee.object) || callee.object === "router";

      if (!isApp && !isRouter) return;

      const args = node.arguments;

      // Pattern: app.use('/prefix', someRouter)
      if (
        args.length >= 2 &&
        args[0].type === "StringLiteral" &&
        args[args.length - 1].type === "Identifier"
      ) {
        const prefix = args[0].value;
        const routerName = args[args.length - 1].name;
        routerPrefixes.set(routerName, prefix);

        // Middle arguments are middleware
        for (let i = 1; i < args.length - 1; i++) {
          const mwName = getMiddlewareName(args[i]);
          if (mwName) {
            if (!routerMiddleware.has(routerName)) {
              routerMiddleware.set(routerName, []);
            }
            if (isAuthMiddleware(mwName)) {
              if (!routerAuth.has(routerName)) {
                routerAuth.set(routerName, []);
              }
              routerAuth.get(routerName)!.push(mwName);
            } else {
              routerMiddleware.get(routerName)!.push(mwName);
            }
          }
        }
        return;
      }

      // Pattern: app.use(middleware) or router.use(middleware) — no path prefix
      // Or: app.use('/prefix', middleware) where middleware is not a router
      for (const arg of args) {
        const mwName = getMiddlewareName(arg);
        if (!mwName) continue;

        if (isApp) {
          if (isAuthMiddleware(mwName)) {
            globalAuth.push(mwName);
          } else {
            globalMiddleware.push(mwName);
          }
        } else if (isRouter) {
          if (!routerMiddleware.has(callee.object)) {
            routerMiddleware.set(callee.object, []);
          }
          if (isAuthMiddleware(mwName)) {
            if (!routerAuth.has(callee.object)) {
              routerAuth.set(callee.object, []);
            }
            routerAuth.get(callee.object)!.push(mwName);
          } else {
            routerMiddleware.get(callee.object)!.push(mwName);
          }
        }
      }
    },
  });

  // Treat common defaults as router/app vars
  appVars.add("app");
  routerVars.add("router");

  // Second pass: extract routes
  traverse(ast, {
    CallExpression(p: any) {
      const node = p.node;
      const callee = getCalleeName(node.callee);
      if (!callee) return;

      const method = callee.property.toLowerCase();
      if (!HTTP_METHODS.has(method)) return;

      const isApp = appVars.has(callee.object);
      const isRouter = routerVars.has(callee.object);
      if (!isApp && !isRouter) return;

      const args = node.arguments;
      if (args.length < 1) return;

      // First arg should be the route path
      const pathArg = args[0];
      let routePath: string;

      if (pathArg.type === "StringLiteral") {
        routePath = pathArg.value;
      } else if (pathArg.type === "TemplateLiteral" && pathArg.quasis?.length === 1) {
        // Simple template literal with no expressions
        routePath = pathArg.quasis[0].value.raw;
      } else {
        // Dynamic route path — warn
        errors.push({
          file: fileName,
          reason: `Dynamic route path detected for ${callee.object}.${method}() — cannot extract static path`,
        });
        return;
      }

      // Extract middleware and handler
      const handlerNode = args.length > 1 ? args[args.length - 1] : null;
      const middlewareArgs = args.slice(1, -1); // everything between path and handler

      // Middleware names
      const routeMiddleware: string[] = [];
      let routeAuth: string | null = null;

      for (const mwArg of middlewareArgs) {
        const mwName = getMiddlewareName(mwArg);
        if (mwName) {
          if (isAuthMiddleware(mwName)) {
            routeAuth = mwName;
          } else {
            routeMiddleware.push(mwName);
          }
        }
      }

      // Check for passport.authenticate() in middleware args
      for (const mwArg of middlewareArgs) {
        if (
          mwArg.type === "CallExpression" &&
          mwArg.callee?.type === "MemberExpression" &&
          mwArg.callee.object?.type === "Identifier" &&
          mwArg.callee.object.name === "passport" &&
          mwArg.callee.property?.type === "Identifier" &&
          mwArg.callee.property.name === "authenticate"
        ) {
          routeAuth = "Bearer";
        }
      }

      // Apply router-level auth
      if (!routeAuth && isRouter) {
        const rAuth = routerAuth.get(callee.object);
        if (rAuth && rAuth.length > 0) {
          routeAuth = rAuth[0];
        }
      }

      // Apply global auth
      if (!routeAuth && globalAuth.length > 0) {
        routeAuth = globalAuth[0];
      }

      // Apply router-level middleware
      if (isRouter) {
        const rMw = routerMiddleware.get(callee.object);
        if (rMw) {
          routeMiddleware.push(...rMw);
        }
      }

      // Apply global middleware
      routeMiddleware.push(...globalMiddleware);

      // Determine prefix
      let prefix: string | null = null;
      if (isRouter) {
        prefix = routerPrefixes.get(callee.object) ?? null;
      }

      // Extract path params from route pattern
      let params = extractPathParams(routePath);

      // Extract request body and query params from handler body
      let requestBody: RequestBodyInfo | null = null;
      if (handlerNode) {
        const queryParams = extractQueryParams(handlerNode);
        params = [...params, ...queryParams];

        requestBody = extractRequestBody(handlerNode);
      }

      // TypeScript type extraction from handler params
      if (handlerNode) {
        const typed = extractTypedParams(handlerNode, typeDefs);
        if (typed.pathParams.length > 0) {
          // Override path params with typed versions (they have real types)
          const typedNames = new Set(typed.pathParams.map((tp) => tp.name));
          params = params.filter(
            (p) => !(p.in === "path" && typedNames.has(p.name))
          );
          params = [...typed.pathParams, ...params];
        }
        if (typed.queryParams.length > 0) {
          const typedQueryNames = new Set(
            typed.queryParams.map((tp) => tp.name)
          );
          params = params.filter(
            (p) => !(p.in === "query" && typedQueryNames.has(p.name))
          );
          params = [...params, ...typed.queryParams];
        }
        if (typed.body) {
          requestBody = typed.body;
        }
      }

      // Controller name — try to find the handler function name
      let controller: string | null = null;
      if (handlerNode) {
        if (handlerNode.type === "Identifier") {
          controller = handlerNode.name;
        } else if (
          handlerNode.type === "MemberExpression" &&
          handlerNode.object?.type === "Identifier" &&
          handlerNode.property?.type === "Identifier"
        ) {
          controller = `${handlerNode.object.name}.${handlerNode.property.name}`;
        }
      }

      // JSDoc description — from the ExpressionStatement parent
      let description: string | null = null;
      const parentNode = p.parent;
      if (parentNode) {
        description = getLeadingJSDoc(parentNode);
      }
      if (!description) {
        description = getLeadingJSDoc(node);
      }

      const fullPath = prefix ? normalizePath(prefix + routePath) : routePath;

      routes.push({
        path: fullPath,
        method: method.toUpperCase() as HttpMethod,
        controller,
        routePrefix: prefix,
        params,
        requestBody,
        responses: [],
        auth: routeAuth,
        middleware: routeMiddleware,
        description,
        source: fileName,
      });
    },
  });
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/");
}

function getMiddlewareName(node: any): string | null {
  if (!node) return null;

  if (node.type === "Identifier") {
    return node.name;
  }

  // passport.authenticate('jwt') → "passport.authenticate"
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.property?.type === "Identifier"
  ) {
    return `${node.callee.object.name}.${node.callee.property.name}`;
  }

  // someFunction() call
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier"
  ) {
    return node.callee.name;
  }

  return null;
}
