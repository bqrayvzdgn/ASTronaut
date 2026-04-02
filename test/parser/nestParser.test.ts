import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseNestRoutes } from "../../src/parser/nestParser";

// Mock the logger so tests don't require pino config
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

function createTempProject(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nest-parser-test-"));

  // Write a tsconfig so ts-morph can parse decorators
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      strict: true,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
    },
    include: ["./**/*.ts"],
  };
  fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  return tmpDir;
}

function cleanupTempDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("NestJS Parser", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
  });

  test("1. Simple controller: @Controller('users') + @Get() -> route found", () => {
    tmpDir = createTempProject({
      "src/users.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Get()
          findAll(): string[] {
            return [];
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.path).toBe("/users");
    expect(route.method).toBe("GET");
    expect(route.controller).toBe("UsersController");
    expect(route.routePrefix).toBe("/users");
  });

  test("2. Parameterized route: @Get(':id') + @Param('id') -> path param extracted", () => {
    tmpDir = createTempProject({
      "src/users.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Param(name?: string): ParameterDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Get(':id')
          findOne(@Param('id') id: string): string {
            return '';
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.path).toBe("/users/:id");
    expect(route.method).toBe("GET");
    expect(route.params).toHaveLength(1);
    expect(route.params[0]).toEqual({
      name: "id",
      in: "path",
      type: "string",
      required: true,
    });
  });

  test("3. DTO request body: @Body() dto: CreateUserDto -> requestBody populated", () => {
    tmpDir = createTempProject({
      "src/dto/create-user.dto.ts": `
        export class CreateUserDto {
          name: string;
          email: string;
          age?: number;
        }
      `,
      "src/users.controller.ts": `
        import { CreateUserDto } from './dto/create-user.dto';

        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Post(path?: string): MethodDecorator { return () => {}; }
        function Body(): ParameterDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Post()
          create(@Body() dto: CreateUserDto): void {}
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.requestBody).not.toBeNull();
    expect(route.requestBody!.type).toBe("CreateUserDto");
    expect(route.requestBody!.properties.length).toBeGreaterThanOrEqual(2);

    const nameProp = route.requestBody!.properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.type).toBe("string");
    expect(nameProp!.required).toBe(true);

    const ageProp = route.requestBody!.properties.find((p) => p.name === "age");
    expect(ageProp).toBeDefined();
    expect(ageProp!.required).toBe(false);
  });

  test("4. Response type: method returns Promise<User> -> response type resolved", () => {
    tmpDir = createTempProject({
      "src/entities/user.entity.ts": `
        export class User {
          id: number;
          name: string;
          email: string;
        }
      `,
      "src/users.controller.ts": `
        import { User } from './entities/user.entity';

        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Get()
          async findAll(): Promise<User> {
            return null as any;
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.responses).toHaveLength(1);
    expect(route.responses[0].type).toBe("User");
    expect(route.responses[0].status).toBe(200);

    const idProp = route.responses[0].properties.find((p) => p.name === "id");
    expect(idProp).toBeDefined();
    expect(idProp!.type).toBe("number");

    const nameProp = route.responses[0].properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.type).toBe("string");
  });

  test("5. Guard detection: @UseGuards(AuthGuard) -> auth field set", () => {
    tmpDir = createTempProject({
      "src/users.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function UseGuards(...guards: any[]): MethodDecorator & ClassDecorator { return () => {}; }
        class AuthGuard {}

        @Controller('users')
        export class UsersController {
          @UseGuards(AuthGuard)
          @Get('profile')
          getProfile(): string {
            return '';
          }

          @Get('public')
          getPublic(): string {
            return '';
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(2);

    const profileRoute = result.routes.find((r) => r.path === "/users/profile");
    expect(profileRoute).toBeDefined();
    expect(profileRoute!.auth).toBe("AuthGuard");

    const publicRoute = result.routes.find((r) => r.path === "/users/public");
    expect(publicRoute).toBeDefined();
    expect(publicRoute!.auth).toBeNull();
  });

  test("6. Class-level guard: applies to all methods", () => {
    tmpDir = createTempProject({
      "src/admin.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Post(path?: string): MethodDecorator { return () => {}; }
        function UseGuards(...guards: any[]): MethodDecorator & ClassDecorator { return () => {}; }
        class AdminGuard {}

        @UseGuards(AdminGuard)
        @Controller('admin')
        export class AdminController {
          @Get('dashboard')
          getDashboard(): string {
            return '';
          }

          @Post('settings')
          updateSettings(): void {}
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(2);

    for (const route of result.routes) {
      expect(route.auth).toBe("AdminGuard");
    }
  });

  test("7. Nested DTO: DTO containing another DTO reference -> properties resolved", () => {
    tmpDir = createTempProject({
      "src/dto/address.dto.ts": `
        export class AddressDto {
          street: string;
          city: string;
          zip: string;
        }
      `,
      "src/dto/create-order.dto.ts": `
        import { AddressDto } from './address.dto';

        export class CreateOrderDto {
          item: string;
          quantity: number;
          shippingAddress: AddressDto;
        }
      `,
      "src/orders.controller.ts": `
        import { CreateOrderDto } from './dto/create-order.dto';

        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Post(path?: string): MethodDecorator { return () => {}; }
        function Body(): ParameterDecorator { return () => {}; }

        @Controller('orders')
        export class OrdersController {
          @Post()
          create(@Body() dto: CreateOrderDto): void {}
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.requestBody).not.toBeNull();
    expect(route.requestBody!.type).toBe("CreateOrderDto");

    const itemProp = route.requestBody!.properties.find((p) => p.name === "item");
    expect(itemProp).toBeDefined();
    expect(itemProp!.type).toBe("string");

    const addressProp = route.requestBody!.properties.find((p) => p.name === "shippingAddress");
    expect(addressProp).toBeDefined();
    expect(addressProp!.type).toBe("AddressDto");
  });

  test("8. Circular dependency: User -> Order -> User -> loop broken, no infinite loop", () => {
    tmpDir = createTempProject({
      "src/entities/order.entity.ts": `
        import { CircularUser } from './user.entity';

        export class CircularOrder {
          id: number;
          total: number;
          buyer: CircularUser;
        }
      `,
      "src/entities/user.entity.ts": `
        import { CircularOrder } from './order.entity';

        export class CircularUser {
          id: number;
          name: string;
          orders: CircularOrder[];
        }
      `,
      "src/users.controller.ts": `
        import { CircularUser } from './entities/user.entity';

        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Get()
          async findAll(): Promise<CircularUser> {
            return null as any;
          }
        }
      `,
    });

    // This test primarily verifies the parser doesn't hang or throw on circular refs
    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.responses[0].type).toBe("CircularUser");
    // Should have resolved some properties without infinite looping
    expect(route.responses[0].properties.length).toBeGreaterThan(0);

    const idProp = route.responses[0].properties.find((p) => p.name === "id");
    expect(idProp).toBeDefined();
  }, 10000); // Extended timeout in case resolution is slow

  test("9. Multiple controllers: two controllers in same file -> both found", () => {
    tmpDir = createTempProject({
      "src/multi.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Post(path?: string): MethodDecorator { return () => {}; }

        @Controller('cats')
        export class CatsController {
          @Get()
          findAll(): string[] {
            return [];
          }
        }

        @Controller('dogs')
        export class DogsController {
          @Get()
          findAll(): string[] {
            return [];
          }

          @Post()
          create(): void {}
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(3);

    const catRoutes = result.routes.filter((r) => r.controller === "CatsController");
    expect(catRoutes).toHaveLength(1);
    expect(catRoutes[0].path).toBe("/cats");
    expect(catRoutes[0].method).toBe("GET");

    const dogRoutes = result.routes.filter((r) => r.controller === "DogsController");
    expect(dogRoutes).toHaveLength(2);
    expect(dogRoutes.find((r) => r.method === "GET")).toBeDefined();
    expect(dogRoutes.find((r) => r.method === "POST")).toBeDefined();
  });

  test("10. Test files excluded from scanning", () => {
    tmpDir = createTempProject({
      "src/users.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('users')
        export class UsersController {
          @Get()
          findAll(): string[] {
            return [];
          }
        }
      `,
      "src/users.controller.spec.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('spec-users')
        export class SpecUsersController {
          @Get()
          findAll(): string[] {
            return [];
          }
        }
      `,
      "src/users.controller.test.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('test-users')
        export class TestUsersController {
          @Get()
          findAll(): string[] {
            return [];
          }
        }
      `,
      "test/integration.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('test-only')
        export class TestOnlyController {
          @Get()
          run(): string { return ''; }
        }
      `,
      "__tests__/e2e.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('e2e-only')
        export class E2eController {
          @Get()
          run(): string { return ''; }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    // Only the main controller should be found
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].controller).toBe("UsersController");
    expect(result.routes[0].path).toBe("/users");
  });

  test("Query param extraction with @Query decorator", () => {
    tmpDir = createTempProject({
      "src/products.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Query(name?: string): ParameterDecorator { return () => {}; }

        @Controller('products')
        export class ProductsController {
          @Get()
          search(@Query('q') query: string, @Query('page') page: number): string[] {
            return [];
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.params).toHaveLength(2);

    const qParam = route.params.find((p) => p.name === "q");
    expect(qParam).toBeDefined();
    expect(qParam!.in).toBe("query");
    expect(qParam!.type).toBe("string");
    expect(qParam!.required).toBe(false);

    const pageParam = route.params.find((p) => p.name === "page");
    expect(pageParam).toBeDefined();
    expect(pageParam!.in).toBe("query");
    expect(pageParam!.type).toBe("number");
  });

  test("Headers extraction with @Headers decorator", () => {
    tmpDir = createTempProject({
      "src/auth.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Headers(name?: string): ParameterDecorator { return () => {}; }

        @Controller('auth')
        export class AuthController {
          @Get('verify')
          verify(@Headers('authorization') token: string): boolean {
            return true;
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0];
    expect(route.params).toHaveLength(1);
    expect(route.params[0]).toEqual({
      name: "authorization",
      in: "header",
      type: "string",
      required: false,
    });
  });

  test("JSDoc comments extracted as description", () => {
    tmpDir = createTempProject({
      "src/items.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller('items')
        export class ItemsController {
          /**
           * Retrieves all items from the database
           */
          @Get()
          findAll(): string[] {
            return [];
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].description).toBe("Retrieves all items from the database");
  });

  test("Controller with no prefix defaults to root path", () => {
    tmpDir = createTempProject({
      "src/root.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }

        @Controller()
        export class RootController {
          @Get('health')
          healthCheck(): string {
            return 'ok';
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].path).toBe("/health");
    expect(result.routes[0].routePrefix).toBeNull();
  });

  test("Method-level @UseGuards overrides class-level", () => {
    tmpDir = createTempProject({
      "src/mixed.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function UseGuards(...guards: any[]): MethodDecorator & ClassDecorator { return () => {}; }
        class BasicGuard {}
        class AdminGuard {}

        @UseGuards(BasicGuard)
        @Controller('mixed')
        export class MixedController {
          @Get('basic')
          basicRoute(): string {
            return '';
          }

          @UseGuards(AdminGuard)
          @Get('admin')
          adminRoute(): string {
            return '';
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(2);

    const basicRoute = result.routes.find((r) => r.path === "/mixed/basic");
    expect(basicRoute).toBeDefined();
    expect(basicRoute!.auth).toBe("BasicGuard");

    const adminRoute = result.routes.find((r) => r.path === "/mixed/admin");
    expect(adminRoute).toBeDefined();
    expect(adminRoute!.auth).toBe("AdminGuard");
  });

  test("All HTTP methods detected", () => {
    tmpDir = createTempProject({
      "src/all-methods.controller.ts": `
        function Controller(prefix?: string): ClassDecorator { return () => {}; }
        function Get(path?: string): MethodDecorator { return () => {}; }
        function Post(path?: string): MethodDecorator { return () => {}; }
        function Put(path?: string): MethodDecorator { return () => {}; }
        function Delete(path?: string): MethodDecorator { return () => {}; }
        function Patch(path?: string): MethodDecorator { return () => {}; }

        @Controller('api')
        export class ApiController {
          @Get()
          list(): void {}

          @Post()
          create(): void {}

          @Put(':id')
          replace(): void {}

          @Delete(':id')
          remove(): void {}

          @Patch(':id')
          update(): void {}
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.routes).toHaveLength(5);

    const methods = result.routes.map((r) => r.method).sort();
    expect(methods).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  });

  test("No controllers found returns empty routes", () => {
    tmpDir = createTempProject({
      "src/service.ts": `
        export class UsersService {
          findAll(): string[] {
            return [];
          }
        }
      `,
    });

    const result = parseNestRoutes(tmpDir);

    expect(result.routes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
