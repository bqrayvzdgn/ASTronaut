import fs from "fs";
import { Project, SourceFile, ClassDeclaration, MethodDeclaration, ParameterDeclaration, Type, Symbol as TsMorphSymbol, Decorator, ts, Node } from "ts-morph";
import * as path from "path";
import { ParseResult, RouteInfo, ParamInfo, RequestBodyInfo, ResponseInfo, PropertyInfo, ParseError, HttpMethod } from "./types";
import { logger } from "../utils/logger";

const HTTP_METHOD_DECORATORS: Record<string, HttpMethod> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
};

const EXCLUDED_PATTERNS = [
  /node_modules/,
  /dist[/\\]/,
  /test[/\\]/,
  /__tests__[/\\]/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

export function parseNestRoutes(repoPath: string): ParseResult {
  const routes: RouteInfo[] = [];
  const errors: ParseError[] = [];

  let project: Project;
  const tsconfigPath = path.join(repoPath, "tsconfig.json");

  try {
    if (fs.existsSync(tsconfigPath)) {
      project = new Project({ tsConfigFilePath: tsconfigPath });
    } else {
      project = new Project({
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          strict: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      });
      project.addSourceFilesAtPaths(path.join(repoPath, "**/*.ts"));
    }
  } catch (err) {
    logger.error({ err, repoPath }, "Failed to create ts-morph project");
    errors.push({ file: repoPath, reason: `Failed to initialize project: ${err}` });
    return { routes, errors };
  }

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const filePath = sf.getFilePath();
    return !EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
  });

  logger.info({ fileCount: sourceFiles.length }, "Scanning NestJS source files");

  for (const sourceFile of sourceFiles) {
    try {
      const fileRoutes = parseSourceFile(sourceFile);
      routes.push(...fileRoutes);
    } catch (err) {
      const filePath = sourceFile.getFilePath();
      logger.warn({ err, file: filePath }, "Error parsing source file");
      errors.push({ file: filePath, reason: `${err}` });
    }
  }

  logger.info({ routeCount: routes.length, errorCount: errors.length }, "NestJS parsing complete");
  return { routes, errors };
}

function parseSourceFile(sourceFile: SourceFile): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const classes = sourceFile.getClasses();

  for (const cls of classes) {
    const controllerDecorator = cls.getDecorator("Controller");
    if (!controllerDecorator) continue;

    const controllerPrefix = extractDecoratorStringArg(controllerDecorator);
    const controllerName = cls.getName() ?? null;
    const classLevelAuth = extractGuardAuth(cls.getDecorators());

    const methods = cls.getMethods();
    for (const method of methods) {
      for (const [decoratorName, httpMethod] of Object.entries(HTTP_METHOD_DECORATORS)) {
        const routeDecorator = method.getDecorator(decoratorName);
        if (!routeDecorator) continue;

        const methodPath = extractDecoratorStringArg(routeDecorator);
        const fullPath = buildFullPath(controllerPrefix, methodPath);

        const params = extractParams(method);
        const requestBody = extractRequestBody(method);
        const responses = extractResponses(method);
        const methodAuth = extractGuardAuth(method.getDecorators());
        const auth = methodAuth ?? classLevelAuth;
        const description = extractJsDocDescription(method);

        routes.push({
          path: fullPath,
          method: httpMethod,
          controller: controllerName,
          routePrefix: controllerPrefix ? `/${stripLeadingSlash(controllerPrefix)}` : null,
          params,
          requestBody,
          responses,
          auth,
          middleware: [],
          description,
          source: sourceFile.getFilePath(),
        });
      }
    }
  }

  return routes;
}

function extractDecoratorStringArg(decorator: Decorator): string | null {
  const args = decorator.getArguments();
  if (args.length === 0) return null;

  const firstArg = args[0];
  const text = firstArg.getText();

  // Strip surrounding quotes (single or double or backtick)
  const match = text.match(/^['"`](.*?)['"`]$/);
  return match ? match[1] : null;
}

function stripLeadingSlash(s: string): string {
  return s.startsWith("/") ? s.slice(1) : s;
}

function buildFullPath(controllerPrefix: string | null, methodPath: string | null): string {
  let parts: string[] = [];

  if (controllerPrefix) {
    parts.push(stripLeadingSlash(controllerPrefix));
  }

  if (methodPath) {
    parts.push(stripLeadingSlash(methodPath));
  }

  const joined = parts.join("/");
  return `/${joined}`;
}

function extractParams(method: MethodDeclaration): ParamInfo[] {
  const params: ParamInfo[] = [];
  const parameters = method.getParameters();

  for (const param of parameters) {
    const paramDecorator = param.getDecorator("Param");
    const queryDecorator = param.getDecorator("Query");
    const headersDecorator = param.getDecorator("Headers");

    if (paramDecorator) {
      const paramName = extractDecoratorStringArg(paramDecorator) ?? param.getName();
      params.push({
        name: paramName,
        in: "path",
        type: resolveParameterTypeName(param),
        required: true,
      });
    } else if (queryDecorator) {
      const queryName = extractDecoratorStringArg(queryDecorator) ?? param.getName();
      params.push({
        name: queryName,
        in: "query",
        type: resolveParameterTypeName(param),
        required: false,
      });
    } else if (headersDecorator) {
      const headerName = extractDecoratorStringArg(headersDecorator) ?? param.getName();
      params.push({
        name: headerName,
        in: "header",
        type: resolveParameterTypeName(param),
        required: false,
      });
    }
  }

  return params;
}

function resolveParameterTypeName(param: ParameterDeclaration): string {
  const typeNode = param.getTypeNode();
  if (typeNode) {
    return typeNode.getText();
  }
  const type = param.getType();
  return simplifyTypeName(type.getText());
}

function simplifyTypeName(typeName: string): string {
  // Remove import(...) wrappers that ts-morph sometimes produces
  return typeName.replace(/import\([^)]*\)\./g, "");
}

function extractRequestBody(method: MethodDeclaration): RequestBodyInfo | null {
  const parameters = method.getParameters();

  for (const param of parameters) {
    const bodyDecorator = param.getDecorator("Body");
    if (!bodyDecorator) continue;

    const type = param.getType();
    const typeName = simplifyTypeName(type.getText());
    const properties = resolveTypeProperties(type, new Set<string>());

    return {
      type: typeName,
      properties,
    };
  }

  return null;
}

function extractHttpCode(method: MethodDeclaration): number {
  const decorator = method.getDecorator("HttpCode");
  if (decorator) {
    const args = decorator.getArguments();
    if (args.length > 0) {
      const code = parseInt(args[0].getText(), 10);
      if (!isNaN(code)) return code;
    }
  }
  return 200;
}

function extractDecoratorTypeArg(
  decorator: Decorator,
  visited: Set<string>
): { typeName: string; properties: PropertyInfo[] } | null {
  const args = decorator.getArguments();
  if (args.length === 0) return null;

  const argText = args[0].getText();
  const typeMatch = argText.match(/type\s*:\s*(\w+)/);
  if (!typeMatch) return null;

  const typeName = typeMatch[1];
  const sourceFile = decorator.getSourceFile();

  // Try local declarations first
  const localDecl = sourceFile.getTypeAlias(typeName) || sourceFile.getInterface(typeName) || sourceFile.getClass(typeName);
  if (localDecl) {
    const type = localDecl.getType();
    const properties = resolveTypeProperties(type, new Set(visited));
    return { typeName, properties };
  }

  // Try resolving through imports across the project
  const project = sourceFile.getProject();
  for (const sf of project.getSourceFiles()) {
    const decl = sf.getTypeAlias(typeName) || sf.getInterface(typeName) || sf.getClass(typeName);
    if (decl) {
      const type = decl.getType();
      const properties = resolveTypeProperties(type, new Set(visited));
      return { typeName, properties };
    }
  }

  return { typeName, properties: [] };
}

function extractApiResponses(method: MethodDeclaration, visited: Set<string>): ResponseInfo[] | null {
  const DECORATOR_STATUS_MAP: Record<string, number> = {
    ApiOkResponse: 200,
    ApiCreatedResponse: 201,
    ApiAcceptedResponse: 202,
    ApiNoContentResponse: 204,
    ApiBadRequestResponse: 400,
    ApiUnauthorizedResponse: 401,
    ApiForbiddenResponse: 403,
    ApiNotFoundResponse: 404,
    ApiConflictResponse: 409,
    ApiInternalServerErrorResponse: 500,
  };

  const decorators = method.getDecorators();
  const responses: ResponseInfo[] = [];

  for (const dec of decorators) {
    const name = dec.getName();

    // Named response decorators (e.g., @ApiOkResponse({ type: UserDto }))
    if (DECORATOR_STATUS_MAP[name] !== undefined) {
      const status = DECORATOR_STATUS_MAP[name];
      const typeInfo = extractDecoratorTypeArg(dec, visited);
      responses.push({
        status,
        type: typeInfo?.typeName ?? null,
        properties: typeInfo?.properties ?? [],
      });
      continue;
    }

    // Generic @ApiResponse({ status: 200, type: UserDto })
    if (name === "ApiResponse") {
      const args = dec.getArguments();
      if (args.length > 0) {
        const argText = args[0].getText();
        const statusMatch = argText.match(/status\s*:\s*(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;
        const typeInfo = extractDecoratorTypeArg(dec, visited);
        responses.push({
          status,
          type: typeInfo?.typeName ?? null,
          properties: typeInfo?.properties ?? [],
        });
      }
    }
  }

  return responses.length > 0 ? responses : null;
}

function extractResponses(method: MethodDeclaration): ResponseInfo[] {
  // 1. Check for Swagger/OpenAPI decorators first
  const apiResponses = extractApiResponses(method, new Set<string>());
  if (apiResponses) return apiResponses;

  // 2. Fall back to return type analysis with @HttpCode support
  const statusCode = extractHttpCode(method);

  const returnType = method.getReturnType();
  let resolvedType = returnType;
  let typeName = simplifyTypeName(returnType.getText());

  // Unwrap Promise<T>
  if (typeName.startsWith("Promise<")) {
    const typeArgs = returnType.getTypeArguments();
    if (typeArgs.length > 0) {
      resolvedType = typeArgs[0];
      typeName = simplifyTypeName(resolvedType.getText());
    }
  }

  if (typeName === "void" || typeName === "undefined") {
    return [{ status: statusCode, type: null, properties: [] }];
  }

  const properties = resolveTypeProperties(resolvedType, new Set<string>());

  return [
    {
      status: statusCode,
      type: typeName,
      properties,
    },
  ];
}

function resolveTypeProperties(type: Type, visited: Set<string>): PropertyInfo[] {
  const properties: PropertyInfo[] = [];
  const typeName = simplifyTypeName(type.getText());

  // Prevent circular resolution
  if (visited.has(typeName)) {
    return properties;
  }
  visited.add(typeName);

  // Handle array types: unwrap to element type
  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      return resolveTypeProperties(elementType, visited);
    }
  }

  // Primitives and built-in types don't have meaningful properties
  if (isPrimitive(typeName)) {
    return properties;
  }

  const typeProperties = type.getProperties();
  for (const prop of typeProperties) {
    const propName = prop.getName();
    // Skip internal/private properties
    if (propName.startsWith("_")) continue;

    const declarations = prop.getDeclarations();
    let propType = "unknown";
    let required = true;

    if (declarations.length > 0) {
      const decl = declarations[0];
      if (Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl)) {
        const declType = decl.getType();
        propType = simplifyTypeName(declType.getText());
        required = !decl.hasQuestionToken();
      } else {
        const declType = decl.getType?.();
        if (declType) {
          propType = simplifyTypeName(declType.getText());
        }
      }
    } else {
      // Fallback: use the symbol's value declaration type
      const valueDecl = prop.getValueDeclaration();
      if (valueDecl) {
        const declType = valueDecl.getType();
        propType = simplifyTypeName(declType.getText());
      }
    }

    properties.push({
      name: propName,
      type: propType,
      required,
    });
  }

  return properties;
}

function isPrimitive(typeName: string): boolean {
  const primitives = ["string", "number", "boolean", "null", "undefined", "void", "any", "unknown", "never", "bigint", "symbol"];
  return primitives.includes(typeName);
}

function extractGuardAuth(decorators: Decorator[]): string | null {
  for (const decorator of decorators) {
    if (decorator.getName() !== "UseGuards") continue;

    const args = decorator.getArguments();
    if (args.length > 0) {
      return args[0].getText();
    }
  }
  return null;
}

function extractJsDocDescription(method: MethodDeclaration): string | null {
  const jsDocs = method.getJsDocs();
  if (jsDocs.length === 0) return null;

  const description = jsDocs[0].getDescription().trim();
  return description || null;
}
