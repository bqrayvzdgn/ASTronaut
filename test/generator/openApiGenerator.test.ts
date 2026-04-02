import * as yaml from "js-yaml";
import { generateOpenApiSpec, GeneratorOptions } from "../../src/generator/openApiGenerator";
import {
  ParseResult,
  RouteInfo,
  HttpMethod,
  ParamInfo,
  RequestBodyInfo,
  ResponseInfo,
  PropertyInfo,
} from "../../src/parser/types";

function makeRoute(overrides: Partial<RouteInfo> = {}): RouteInfo {
  return {
    path: "/api/test",
    method: "GET",
    controller: "TestController",
    routePrefix: "/api",
    params: [],
    requestBody: null,
    responses: [],
    auth: null,
    middleware: [],
    description: null,
    source: "test.ts",
    ...overrides,
  };
}

function makeParseResult(routes: RouteInfo[] = []): ParseResult {
  return { routes, errors: [] };
}

const defaultOptions: GeneratorOptions = {
  title: "TestAPI",
  version: "1.0.0",
};

function parseSpec(yamlStr: string): Record<string, any> {
  return yaml.load(yamlStr) as Record<string, any>;
}

describe("generateOpenApiSpec", () => {
  describe("basic structure", () => {
    it("should produce a valid OpenAPI 3.0.3 spec for a simple route", () => {
      const route = makeRoute({
        path: "/api/health",
        method: "GET",
        controller: "HealthController",
        description: "Health check endpoint",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.openapi).toBe("3.0.3");
      expect(spec.info.title).toBe("TestAPI");
      expect(spec.info.version).toBe("1.0.0");
      expect(spec.paths["/api/health"]).toBeDefined();
      expect(spec.paths["/api/health"].get).toBeDefined();
      expect(spec.paths["/api/health"].get.description).toBe("Health check endpoint");
      expect(spec.paths["/api/health"].get.tags).toEqual(["HealthController"]);
    });

    it("should produce an empty paths object for an empty ParseResult", () => {
      const result = generateOpenApiSpec(makeParseResult(), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.openapi).toBe("3.0.3");
      expect(spec.paths).toEqual({});
      expect(spec.info.title).toBe("TestAPI");
    });

    it("should set the version info from options", () => {
      const options: GeneratorOptions = { title: "MyApp", version: "abc123" };
      const result = generateOpenApiSpec(makeParseResult(), options);
      const spec = parseSpec(result);

      expect(spec.info.version).toBe("abc123");
      expect(spec.info.title).toBe("MyApp");
    });

    it("should not include a servers array", () => {
      const result = generateOpenApiSpec(makeParseResult(), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.servers).toBeUndefined();
    });
  });

  describe("YAML format", () => {
    it("should produce valid parseable YAML", () => {
      const route = makeRoute({ path: "/api/items", method: "GET" });
      const yamlStr = generateOpenApiSpec(makeParseResult([route]), defaultOptions);

      expect(typeof yamlStr).toBe("string");
      expect(() => yaml.load(yamlStr)).not.toThrow();

      const spec = parseSpec(yamlStr);
      expect(spec).toBeDefined();
      expect(spec.openapi).toBe("3.0.3");
    });
  });

  describe("parameters", () => {
    it("should convert route params to OpenAPI parameter objects", () => {
      const route = makeRoute({
        path: "/api/users/{id}",
        method: "GET",
        controller: "UsersController",
        params: [
          { name: "id", in: "path", type: "int", required: true },
          { name: "includeDeleted", in: "query", type: "boolean", required: false },
        ],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const params = spec.paths["/api/users/{id}"].get.parameters;
      expect(params).toHaveLength(2);

      expect(params[0]).toEqual({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" },
      });

      expect(params[1]).toEqual({
        name: "includeDeleted",
        in: "query",
        required: false,
        schema: { type: "boolean" },
      });
    });

    it("should handle header and cookie params", () => {
      const route = makeRoute({
        path: "/api/data",
        method: "GET",
        params: [
          { name: "X-Request-Id", in: "header", type: "string", required: true },
          { name: "session", in: "cookie", type: "string", required: false },
        ],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);
      const params = spec.paths["/api/data"].get.parameters;

      expect(params[0].in).toBe("header");
      expect(params[1].in).toBe("cookie");
    });
  });

  describe("request body", () => {
    it("should create requestBody with $ref to component schema", () => {
      const route = makeRoute({
        path: "/api/users",
        method: "POST",
        controller: "UsersController",
        requestBody: {
          type: "CreateUserDto",
          properties: [
            { name: "name", type: "string", required: true },
            { name: "email", type: "string", required: true },
            { name: "age", type: "int", required: false },
          ],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const operation = spec.paths["/api/users"].post;
      expect(operation.requestBody).toBeDefined();
      expect(operation.requestBody.required).toBe(true);
      expect(operation.requestBody.content["application/json"].schema.$ref).toBe(
        "#/components/schemas/UsersController.CreateUserDto"
      );

      const schema = spec.components.schemas["UsersController.CreateUserDto"];
      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties.name).toEqual({ type: "string" });
      expect(schema.properties.email).toEqual({ type: "string" });
      expect(schema.properties.age).toEqual({ type: "integer" });
      expect(schema.required).toEqual(["name", "email"]);
    });
  });

  describe("responses", () => {
    it("should build response schemas with $ref for typed responses", () => {
      const route = makeRoute({
        path: "/api/users/{id}",
        method: "GET",
        controller: "UsersController",
        responses: [
          {
            status: 200,
            type: "UserDto",
            properties: [
              { name: "id", type: "int", required: true },
              { name: "name", type: "string", required: true },
            ],
          },
          {
            status: 404,
            type: null,
            properties: [],
          },
        ],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const responses = spec.paths["/api/users/{id}"].get.responses;
      expect(responses["200"]).toBeDefined();
      expect(responses["200"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/UsersController.UserDto"
      );
      expect(responses["200"].description).toBe("Success");

      expect(responses["404"]).toBeDefined();
      expect(responses["404"].description).toBe("Not Found");
      expect(responses["404"].content).toBeUndefined();

      const schema = spec.components.schemas["UsersController.UserDto"];
      expect(schema).toBeDefined();
      expect(schema.properties.id).toEqual({ type: "integer" });
      expect(schema.required).toEqual(["id", "name"]);
    });

    it("should add default 200 response when no responses defined", () => {
      const route = makeRoute({
        path: "/api/ping",
        method: "GET",
        responses: [],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const responses = spec.paths["/api/ping"].get.responses;
      expect(responses["200"]).toEqual({ description: "Success" });
    });
  });

  describe("authentication", () => {
    it("should add Bearer securityScheme when auth is Bearer", () => {
      const route = makeRoute({
        path: "/api/protected",
        method: "GET",
        auth: "Bearer",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components.securitySchemes.Bearer).toEqual({
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      });

      const operation = spec.paths["/api/protected"].get;
      expect(operation.security).toEqual([{ Bearer: [] }]);
    });

    it("should add ApiKey securityScheme when auth is ApiKey", () => {
      const route = makeRoute({
        path: "/api/external",
        method: "GET",
        auth: "ApiKey",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components.securitySchemes.ApiKey).toEqual({
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      });

      const operation = spec.paths["/api/external"].get;
      expect(operation.security).toEqual([{ ApiKey: [] }]);
    });

    it("should not add securitySchemes when no route has auth", () => {
      const route = makeRoute({ path: "/api/public", auth: null });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components?.securitySchemes).toBeUndefined();
    });

    it("should handle JWT auth type as Bearer", () => {
      const route = makeRoute({
        path: "/api/secure",
        method: "GET",
        auth: "jwt",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components.securitySchemes.Bearer).toBeDefined();
      expect(spec.paths["/api/secure"].get.security).toEqual([{ Bearer: [] }]);
    });
  });

  describe("schema naming", () => {
    it("should use Controller.TypeName format for schema names", () => {
      const route = makeRoute({
        path: "/api/users",
        method: "POST",
        controller: "UsersController",
        requestBody: {
          type: "UserDto",
          properties: [{ name: "name", type: "string", required: true }],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components.schemas["UsersController.UserDto"]).toBeDefined();
    });

    it("should produce different schema names for same DTO in different controllers", () => {
      const route1 = makeRoute({
        path: "/api/users",
        method: "POST",
        controller: "UsersController",
        requestBody: {
          type: "CreateDto",
          properties: [{ name: "name", type: "string", required: true }],
        },
      });
      const route2 = makeRoute({
        path: "/api/products",
        method: "POST",
        controller: "ProductsController",
        requestBody: {
          type: "CreateDto",
          properties: [
            { name: "title", type: "string", required: true },
            { name: "price", type: "float", required: true },
          ],
        },
      });
      const result = generateOpenApiSpec(
        makeParseResult([route1, route2]),
        defaultOptions
      );
      const spec = parseSpec(result);

      expect(spec.components.schemas["UsersController.CreateDto"]).toBeDefined();
      expect(spec.components.schemas["ProductsController.CreateDto"]).toBeDefined();

      expect(
        spec.components.schemas["UsersController.CreateDto"].properties.name
      ).toBeDefined();
      expect(
        spec.components.schemas["ProductsController.CreateDto"].properties.title
      ).toBeDefined();
      expect(
        spec.components.schemas["ProductsController.CreateDto"].properties.price
      ).toEqual({ type: "number" });
    });

    it("should use Default prefix when controller is null", () => {
      const route = makeRoute({
        path: "/api/misc",
        method: "POST",
        controller: null,
        requestBody: {
          type: "MiscDto",
          properties: [{ name: "data", type: "string", required: true }],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.components.schemas["Default.MiscDto"]).toBeDefined();
    });
  });

  describe("multiple routes on same path", () => {
    it("should merge GET and POST on the same path correctly", () => {
      const getRoute = makeRoute({
        path: "/api/users",
        method: "GET",
        controller: "UsersController",
        description: "List all users",
      });
      const postRoute = makeRoute({
        path: "/api/users",
        method: "POST",
        controller: "UsersController",
        description: "Create a user",
        requestBody: {
          type: "CreateUserDto",
          properties: [{ name: "name", type: "string", required: true }],
        },
      });
      const result = generateOpenApiSpec(
        makeParseResult([getRoute, postRoute]),
        defaultOptions
      );
      const spec = parseSpec(result);

      const pathItem = spec.paths["/api/users"];
      expect(pathItem.get).toBeDefined();
      expect(pathItem.post).toBeDefined();
      expect(pathItem.get.description).toBe("List all users");
      expect(pathItem.post.description).toBe("Create a user");
      expect(pathItem.post.requestBody).toBeDefined();
    });

    it("should support all HTTP methods on a single path", () => {
      const methods: HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH"];
      const routes = methods.map((method) =>
        makeRoute({
          path: "/api/resource",
          method,
          controller: "ResourceController",
        })
      );
      const result = generateOpenApiSpec(makeParseResult(routes), defaultOptions);
      const spec = parseSpec(result);

      for (const method of methods) {
        expect(spec.paths["/api/resource"][method.toLowerCase()]).toBeDefined();
      }
    });
  });

  describe("type mapping", () => {
    it("should map int to integer", () => {
      const route = makeRoute({
        path: "/api/items/{id}",
        method: "GET",
        params: [{ name: "id", in: "path", type: "int", required: true }],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/items/{id}"].get.parameters[0].schema.type).toBe(
        "integer"
      );
    });

    it("should map string to string", () => {
      const route = makeRoute({
        path: "/api/items",
        method: "GET",
        params: [{ name: "filter", in: "query", type: "string", required: false }],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/items"].get.parameters[0].schema.type).toBe("string");
    });

    it("should map boolean to boolean", () => {
      const route = makeRoute({
        path: "/api/items",
        method: "GET",
        params: [{ name: "active", in: "query", type: "boolean", required: false }],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/items"].get.parameters[0].schema.type).toBe("boolean");
    });

    it("should map float and double to number", () => {
      const route = makeRoute({
        path: "/api/products",
        method: "POST",
        controller: "ProductsController",
        requestBody: {
          type: "ProductDto",
          properties: [
            { name: "price", type: "float", required: true },
            { name: "weight", type: "double", required: false },
            { name: "tax", type: "decimal", required: false },
          ],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const schema = spec.components.schemas["ProductsController.ProductDto"];
      expect(schema.properties.price).toEqual({ type: "number" });
      expect(schema.properties.weight).toEqual({ type: "number" });
      expect(schema.properties.tax).toEqual({ type: "number" });
    });

    it("should map array type correctly", () => {
      const route = makeRoute({
        path: "/api/data",
        method: "POST",
        controller: "DataController",
        requestBody: {
          type: "DataDto",
          properties: [{ name: "tags", type: "array", required: false }],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const schema = spec.components.schemas["DataController.DataDto"];
      expect(schema.properties.tags).toEqual({
        type: "array",
        items: { type: "string" },
      });
    });

    it("should map any and object types to object", () => {
      const route = makeRoute({
        path: "/api/data",
        method: "POST",
        controller: "DataController",
        requestBody: {
          type: "FlexDto",
          properties: [
            { name: "metadata", type: "any", required: false },
            { name: "config", type: "object", required: false },
          ],
        },
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const schema = spec.components.schemas["DataController.FlexDto"];
      expect(schema.properties.metadata).toEqual({ type: "object" });
      expect(schema.properties.config).toEqual({ type: "object" });
    });

    it("should default unknown types to string", () => {
      const route = makeRoute({
        path: "/api/items/{id}",
        method: "GET",
        params: [{ name: "id", in: "path", type: "uuid", required: true }],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/items/{id}"].get.parameters[0].schema.type).toBe(
        "string"
      );
    });
  });

  describe("operationId generation", () => {
    it("should generate operationId from controller, method, and path", () => {
      const route = makeRoute({
        path: "/api/users/{id}",
        method: "GET",
        controller: "UsersController",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const opId = spec.paths["/api/users/{id}"].get.operationId;
      expect(opId).toBeDefined();
      expect(typeof opId).toBe("string");
      expect(opId.length).toBeGreaterThan(0);
    });

    it("should use 'default' prefix when controller is null", () => {
      const route = makeRoute({
        path: "/api/ping",
        method: "GET",
        controller: null,
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const opId = spec.paths["/api/ping"].get.operationId;
      expect(opId).toContain("default");
    });

    it("should generate unique operationIds for different methods on same path", () => {
      const getRoute = makeRoute({ path: "/api/users", method: "GET" });
      const postRoute = makeRoute({ path: "/api/users", method: "POST" });
      const result = generateOpenApiSpec(
        makeParseResult([getRoute, postRoute]),
        defaultOptions
      );
      const spec = parseSpec(result);

      const getOpId = spec.paths["/api/users"].get.operationId;
      const postOpId = spec.paths["/api/users"].post.operationId;
      expect(getOpId).not.toBe(postOpId);
    });
  });

  describe("tags", () => {
    it("should use controller name as tag", () => {
      const route = makeRoute({
        path: "/api/orders",
        method: "GET",
        controller: "OrdersController",
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/orders"].get.tags).toEqual(["OrdersController"]);
    });

    it("should use 'default' tag when controller is null", () => {
      const route = makeRoute({
        path: "/api/misc",
        method: "GET",
        controller: null,
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      expect(spec.paths["/api/misc"].get.tags).toEqual(["default"]);
    });
  });

  describe("edge cases", () => {
    it("should not duplicate schemas when same type referenced by multiple routes", () => {
      const route1 = makeRoute({
        path: "/api/users",
        method: "GET",
        controller: "UsersController",
        responses: [
          {
            status: 200,
            type: "UserDto",
            properties: [
              { name: "id", type: "int", required: true },
              { name: "name", type: "string", required: true },
            ],
          },
        ],
      });
      const route2 = makeRoute({
        path: "/api/users/{id}",
        method: "GET",
        controller: "UsersController",
        responses: [
          {
            status: 200,
            type: "UserDto",
            properties: [
              { name: "id", type: "int", required: true },
              { name: "name", type: "string", required: true },
            ],
          },
        ],
      });
      const result = generateOpenApiSpec(
        makeParseResult([route1, route2]),
        defaultOptions
      );
      const spec = parseSpec(result);

      // Schema should exist exactly once
      expect(spec.components.schemas["UsersController.UserDto"]).toBeDefined();
      // Both responses reference the same schema
      expect(
        spec.paths["/api/users"].get.responses["200"].content["application/json"]
          .schema.$ref
      ).toBe("#/components/schemas/UsersController.UserDto");
      expect(
        spec.paths["/api/users/{id}"].get.responses["200"].content[
          "application/json"
        ].schema.$ref
      ).toBe("#/components/schemas/UsersController.UserDto");
    });

    it("should handle route with no params, no body, no responses, no auth", () => {
      const route = makeRoute({
        path: "/api/ping",
        method: "GET",
        controller: "HealthController",
        params: [],
        requestBody: null,
        responses: [],
        auth: null,
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const operation = spec.paths["/api/ping"].get;
      expect(operation.parameters).toBeUndefined();
      expect(operation.requestBody).toBeUndefined();
      expect(operation.responses["200"]).toEqual({ description: "Success" });
      expect(operation.security).toBeUndefined();
    });

    it("should handle response with type but no properties", () => {
      const route = makeRoute({
        path: "/api/count",
        method: "GET",
        controller: "StatsController",
        responses: [
          {
            status: 200,
            type: "integer",
            properties: [],
          },
        ],
      });
      const result = generateOpenApiSpec(makeParseResult([route]), defaultOptions);
      const spec = parseSpec(result);

      const response = spec.paths["/api/count"].get.responses["200"];
      expect(response.content["application/json"].schema.type).toBe("integer");
      // Should NOT create a component schema for primitive types
      expect(spec.components?.schemas?.["StatsController.integer"]).toBeUndefined();
    });

    it("should handle multiple different auth types across routes", () => {
      const bearerRoute = makeRoute({
        path: "/api/users",
        method: "GET",
        auth: "Bearer",
      });
      const apiKeyRoute = makeRoute({
        path: "/api/external",
        method: "GET",
        auth: "ApiKey",
      });
      const result = generateOpenApiSpec(
        makeParseResult([bearerRoute, apiKeyRoute]),
        defaultOptions
      );
      const spec = parseSpec(result);

      expect(spec.components.securitySchemes.Bearer).toBeDefined();
      expect(spec.components.securitySchemes.ApiKey).toBeDefined();
    });
  });
});
