# AutoDocAPI — Detayli Gelistirme Plani

> Bu dokuman, projeyi sifirdan gelistirmek icin gereken tum kararlari, teknik detaylari ve uygulama talimatlarini icerir.
> Claude Code'a verildiginde projeyi bastan sona uretebilmelidir.

---

## 1. Proje Tanimi

**AutoDocAPI**, GitHub Actions deploy basarili olduktan sonra repo'nun kaynak kodunu AST ile analiz ederek OpenAPI 3.0.3 spec uretip PR olarak acan bir GitHub App.

### Temel Prensipler
- **AI yok** — saf AST parser. Hallucination riski sifir.
- **Kodda ne varsa o** — olmayan sey spec'e girmez, tahmin yapilmaz.
- **Sifir konfigurasyon** ile calisir, istege bagli `.autodoc.yml` override destegi.
- **Kaynak kod guvenligi** — analiz sonrasi sunucudan hemen silinir.

---

## 2. Teknoloji Stack

| Katman | Teknoloji | Versiyon |
|---|---|---|
| Runtime | Node.js | 20 LTS |
| Backend Framework | Express | 4.x |
| Dil | TypeScript | 5.x |
| AST (JS/TS) | ts-morph + Babel (@babel/parser, @babel/traverse) | latest |
| AST (C#) | Roslyn (.NET CLI tool, child process) | .NET 8 |
| Veritabani | PostgreSQL | 16 |
| ORM / Migration | Drizzle ORM + drizzle-kit | latest |
| Loglama | Pino | latest |
| GitHub API | Octokit (@octokit/app, @octokit/rest) | latest |
| Test | Jest + ts-jest | latest |
| CI/CD | GitHub Actions | - |
| Hosting | Hostinger VPS (Node.js + .NET SDK kurulu) | - |

---

## 3. Desteklenen Diller ve Framework'ler

| Dil | Framework | AST Araci | Entegrasyon Yontemi |
|---|---|---|---|
| JavaScript | Express | Babel (@babel/parser + @babel/traverse) | In-process |
| TypeScript | Express | Babel (@babel/parser + @babel/traverse) | In-process |
| TypeScript | NestJS | ts-morph | In-process |
| C# | ASP.NET Core (Controller-based) | Roslyn (MSBuildWorkspace) | `child_process.execFile("dotnet", ["analyzer.dll", "/repo/path"])` → stdout JSON |
| C# | ASP.NET Core (Minimal API) | Roslyn (MSBuildWorkspace) | `child_process.execFile("dotnet", ["analyzer.dll", "/repo/path"])` → stdout JSON |

---

## 4. Mimari Genel Bakis

### 4.1 Akis Diyagrami

```
GitHub: Deploy workflow basarili (workflow_run completed event)
    |
    v
GitHub webhook POST → https://api.autodocapi.com/webhook/github
    |
    v
+--------------------------------------------------+
|              AutoDocAPI Backend                    |
|                                                   |
|  1. Webhook Handler                               |
|     - X-Hub-Signature-256 dogrulama               |
|     - event_type === "workflow_run" kontrolu       |
|     - action === "completed" kontrolu              |
|     - conclusion === "success" kontrolu            |
|     - Rate limit kontrolu (repo bazli)             |
|     - Paralel limit kontrolu (max N eszamanli)     |
|     - Debounce: ayni repo icin kuyrukta bekleyen   |
|       varsa eskiyi cikar, yenisini ekle            |
|                                                   |
|  2. Yetki Kontrolu                                |
|     - GET /repos/{owner}/{repo} → permissions.push |
|       kontrolu                                     |
|     - Repo archived mi kontrolu                    |
|     - Yetersizse analizi baslatma                  |
|                                                   |
|  3. Repo Manager                                  |
|     - git clone --depth 1                          |
|     - Hassas dosyalari sil (.env, *.pem, *.key vb)|
|     - Analiz bitince hemen sil                     |
|                                                   |
|  4. Config Loader                                  |
|     - .autodoc.yml varsa → oku (sadece framework   |
|       ve docs_output alanlari)                     |
|     - Yoksa → otomatik algilama                    |
|                                                   |
|  5. Framework Detector                             |
|     - package.json oku → "express" veya            |
|       "@nestjs/core" dependency kontrolu           |
|     - *.csproj dosyasi ara →                       |
|       "Microsoft.AspNetCore" referansi kontrol     |
|     - .autodoc.yml'deki framework degeri override   |
|                                                   |
|  6. Parser (framework'e gore)                      |
|     ├── Express → expressParser (Babel AST)        |
|     ├── NestJS → nestParser (ts-morph)             |
|     └── ASP.NET → dotnetBridge (child_process)     |
|     → Hepsi ayni JSON formatta cikti uretir        |
|                                                   |
|  7. OpenAPI Generator                              |
|     - Ortak JSON → OpenAPI 3.0.3 spec              |
|     - Format: YAML                                 |
|     - Versiyon: GitHub API ile tag al, yoksa        |
|       commit SHA                                   |
|     - Schema isimleri: Controller.TypeName formati  |
|                                                   |
|  8. GitHub Service (PR)                            |
|     - Token gecerliligi kontrol et, gerekirse yenile|
|     - Branch olustur:                              |
|       autodocapi/docs-YYYY-MM-DD-HHmmss            |
|     - docs/openapi.yaml (veya config'deki yol)     |
|       dosyasini commit et                          |
|     - PR ac: title + basit description             |
|     - Footer'da guvenlik notu ekle                 |
|     - Kismi sonucta hatalari raporla               |
|                                                   |
|  9. Cleanup                                        |
|     - Klonlanan repo dizinini sil                  |
|                                                   |
| 10. DB Kayit                                       |
|     - Analiz sonucu + uretilen spec'i kaydet       |
|     - Webhook event'i logla                        |
+--------------------------------------------------+
         |
         v
    PostgreSQL
```

### 4.2 Entegrasyon Modeli

```
Framework Detector
    |
    ├── package.json → Express/NestJS
    |   └── ts-morph / Babel (in-process, ayni Node.js sureci)
    |        └── Ortak JSON format
    |
    ├── *.csproj → ASP.NET Core
    |   └── child_process.execFile("dotnet", ["analyzer.dll", repoPath])
    |        └── dotnet restore → MSBuildWorkspace → parse
    |        └── restore basarisiz → fallback: syntax-only parse
    |        └── stdout → JSON.parse → Ortak JSON format
    |
    v
OpenAPI Generator (tek, ortak modul)
    |
    v
PR Service → GitHub'a PR ac
```

---

## 5. Dosya Yapisi

```
autodocapi/
├── src/
│   ├── api/
│   │   ├── webhookHandler.ts       # GitHub webhook endpoint
│   │   ├── healthHandler.ts        # GET /health
│   │   └── routes.ts               # Express route tanimlari
│   ├── parser/
│   │   ├── expressParser.ts        # Babel AST ile Express route parse
│   │   ├── nestParser.ts           # ts-morph ile NestJS parse
│   │   ├── dotnetBridge.ts         # child_process ile .NET CLI wrapper
│   │   └── types.ts                # Ortak ParseResult tipi
│   ├── generator/
│   │   └── openApiGenerator.ts     # ParseResult → OpenAPI 3.0.3 spec
│   ├── github/
│   │   ├── appAuth.ts              # GitHub App JWT + installation token
│   │   ├── repoManager.ts          # git clone + hassas dosya silme + cleanup
│   │   └── prService.ts            # Yetki kontrol + Branch + commit + PR olusturma
│   ├── detector/
│   │   └── frameworkDetector.ts    # package.json / .csproj analizi
│   ├── config/
│   │   ├── index.ts                # Environment config (dotenv)
│   │   └── autodocConfig.ts        # .autodoc.yml okuyucu (sadece framework + docs_output)
│   ├── db/
│   │   ├── connection.ts           # Drizzle + pg baglantisi
│   │   ├── schema.ts               # Drizzle tablo tanimlari
│   │   └── migrations/             # drizzle-kit ile uretilen migration'lar
│   ├── queue/
│   │   └── analysisQueue.ts        # In-memory kuyruk (max N paralel + debounce)
│   ├── utils/
│   │   ├── logger.ts               # Pino logger yapilandirmasi
│   │   └── rateLimiter.ts          # Repo bazli rate limiting
│   └── app.ts                      # Express app baslat + middleware
├── analyzer/                        # .NET Roslyn projesi
│   ├── AutoDocAnalyzer.csproj
│   ├── Program.cs                   # CLI entry point: dotnet restore → MSBuildWorkspace → parse → JSON stdout
│   ├── Parsers/
│   │   ├── ControllerParser.cs      # [ApiController] + [HttpGet] vb. parse
│   │   └── MinimalApiParser.cs      # app.MapGet() vb. parse
│   └── Models/
│       └── RouteInfo.cs             # Ortak JSON formatina uygun C# model
├── test/
│   ├── parser/
│   │   ├── expressParser.test.ts
│   │   ├── nestParser.test.ts
│   │   └── dotnetBridge.test.ts
│   ├── generator/
│   │   └── openApiGenerator.test.ts
│   └── detector/
│       └── frameworkDetector.test.ts
├── .github/
│   └── workflows/
│       └── deploy.yml               # Test → Build → SSH deploy to VPS
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── jest.config.ts
├── .env.example
├── .gitignore
└── README.md
```

---

## 6. Veritabani Semasi (Drizzle)

### 6.1 Tablo: installations

GitHub App kurulumlarini takip eder. Bir installation birden fazla repo'ya erisim verebilir (org kurulumu).

```typescript
// src/db/schema.ts
import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const installations = pgTable("installations", {
  id: serial("id").primaryKey(),
  githubInstallationId: integer("github_installation_id").notNull().unique(),
  owner: text("owner").notNull(),              // GitHub kullanici veya org adi
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### 6.2 Tablo: repos

Installation'a bagli repo'lari takip eder.

```typescript
export const repos = pgTable("repos", {
  id: serial("id").primaryKey(),
  installationId: integer("installation_id").references(() => installations.id).notNull(),
  repoName: text("repo_name").notNull(),       // Repo adi (owner olmadan)
  repoFullName: text("repo_full_name").notNull(), // "owner/repo"
  isActive: text("is_active", { enum: ["true", "false"] }).notNull().default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### 6.3 Tablo: analyses

Her analiz sonucunu kayit eder.

```typescript
export const analyses = pgTable("analyses", {
  id: serial("id").primaryKey(),
  repoId: integer("repo_id").references(() => repos.id).notNull(),
  commitSha: text("commit_sha").notNull(),
  tag: text("tag"),
  spec: text("spec").notNull(),
  status: text("status", { enum: ["success", "partial", "failed"] }).notNull(),
  errors: jsonb("errors"),
  endpointCount: integer("endpoint_count"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### 6.4 Tablo: webhook_events

Gelen tum webhook'lari loglar.

```typescript
export const webhookEvents = pgTable("webhook_events", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  action: text("action"),
  repoFullName: text("repo_full_name"),
  payload: jsonb("payload").notNull(),
  processed: text("processed", { enum: ["pending", "processing", "done", "skipped", "error"] }).notNull().default("pending"),
  processedAt: timestamp("processed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### 6.5 Tablo Iliskileri

```
installations (1) ──→ (N) repos (1) ──→ (N) analyses
```

---

## 7. Parser Ortak JSON Formati

**TUM** parser'lar (Express, NestJS, ASP.NET) bu formatta cikti uretmelidir.

### 7.1 TypeScript Tip Tanimlari

```typescript
// src/parser/types.ts

export interface ParseResult {
  routes: RouteInfo[];
  errors: ParseError[];
}

export interface RouteInfo {
  path: string;
  method: HttpMethod;
  controller: string | null;
  routePrefix: string | null;
  params: ParamInfo[];
  requestBody: RequestBodyInfo | null;
  responses: ResponseInfo[];
  auth: string | null;
  middleware: string[];
  description: string | null;
  source: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface ParamInfo {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  type: string;
  required: boolean;
}

export interface RequestBodyInfo {
  type: string;
  properties: PropertyInfo[];
}

export interface ResponseInfo {
  status: number;
  type: string | null;
  properties: PropertyInfo[];
}

export interface PropertyInfo {
  name: string;
  type: string;
  required: boolean;
}

export interface ParseError {
  file: string;
  reason: string;
}
```

### 7.2 Ornek JSON Ciktisi

```json
{
  "routes": [
    {
      "path": "/api/users/{id}",
      "method": "GET",
      "controller": "UsersController",
      "routePrefix": "/api/users",
      "params": [
        { "name": "id", "in": "path", "type": "int", "required": true },
        { "name": "page", "in": "query", "type": "int", "required": false }
      ],
      "requestBody": null,
      "responses": [
        {
          "status": 200,
          "type": "User",
          "properties": [
            { "name": "id", "type": "int", "required": true },
            { "name": "email", "type": "string", "required": true }
          ]
        },
        { "status": 404, "type": null, "properties": [] }
      ],
      "auth": "Bearer",
      "middleware": ["rateLimiter"],
      "description": "Returns a user by ID",
      "source": "src/Controllers/UsersController.cs:14"
    }
  ],
  "errors": [
    { "file": "src/Routes/legacy.cs", "reason": "parse error at line 42" }
  ]
}
```

---

## 8. Modul Detaylari

### 8.1 src/app.ts — Uygulama Giris Noktasi

```
- Express uygulamasini olustur
- Middleware'leri yukle: JSON body parser, Pino HTTP logger
- Route'lari bagla: /webhook/github, /health
- Portu dinle (process.env.PORT || 3000)
```

### 8.2 src/api/webhookHandler.ts — Webhook Isleme

```
POST /webhook/github

1. X-Hub-Signature-256 header'ini dogrula
   - HMAC SHA256 ile payload'i imzala
   - GitHub'dan gelen signature ile karsilastir
   - Eslesmezse 401 don

2. Event kontrolu
   - x-github-event header === "workflow_run" degilse → 200 + ignore
   - payload.action !== "completed" → 200 + ignore
   - payload.workflow_run.conclusion !== "success" → 200 + ignore

3. Rate limit kontrolu
   - repo_full_name bazli (ornek: saat basina max 10 analiz)
   - Limit asildiysa → 429 don

4. Kuyruga ekle (debounce ile)
   - analysisQueue.enqueue(webhookPayload)
   - Ayni repo icin kuyrukta bekleyen is varsa → eskiyi cikar, yenisini ekle
   - Ayni repo icin calisan is varsa → bitmesini bekle, yeni is kuyruğa girsin
   - 202 Accepted don

5. DB'ye webhook event kaydet
```

### 8.3 src/queue/analysisQueue.ts — Analiz Kuyrugu

```
- Basit in-memory kuyruk
- Ayni anda max N analiz (ornek: N=3, env'den okunur)
- FIFO sirasi
- Debounce: ayni repo icin kuyrukta bekleyen varsa eskiyi at

Kuyruk isleme akisi:
1. Kuyruktan bir is al
2. processAnalysis(webhookPayload) cagir
3. Tamamlaninca sonraki isi al

processAnalysis fonksiyonu:
  a. Yetki kontrolu: repo'ya push yetkisi var mi + archived mi kontrol et
  b. repoManager.clone(repo) → repoPath
  c. repoManager.removeSensitiveFiles(repoPath) → hassas dosyalari sil
  d. configLoader.load(repoPath) → config (opsiyonel)
  e. frameworkDetector.detect(repoPath, config) → framework
  f. parser.parse(repoPath, framework) → ParseResult
  g. Tag bilgisini GitHub API ile al (commit SHA → tag eslestirme)
  h. openApiGenerator.generate(parseResult, options) → spec string
  i. Token gecerliligi kontrol et, gerekirse yenile
  j. prService.createPR(repo, spec, parseResult)
  k. DB'ye analiz sonucunu kaydet
  l. repoManager.cleanup(repoPath) → klonlanan dizini sil
```

### 8.4 src/github/appAuth.ts — GitHub App Kimlik Dogrulama

```
GitHub App kimlik dogrulama akisi:
1. App private key ile JWT token olustur (jsonwebtoken kullan)
   - iss: APP_ID
   - exp: 10 dakika
   - iat: simdiki zaman
2. JWT ile installation access token al
   - POST /app/installations/{installation_id}/access_tokens
3. Token'i DB'de sakla (installations.accessToken + tokenExpiresAt)
4. Token suresi dolmadan once yenile (tokenExpiresAt kontrolu)

getValidToken(installationId):
  - DB'den token ve tokenExpiresAt'i al
  - tokenExpiresAt > now + 5 dakika → mevcut token'i don (5dk tampon)
  - Degilse → yeni token al, DB'yi guncelle, yeni token'i don

Gerekli npm paketleri: @octokit/app, @octokit/rest
```

### 8.5 src/github/repoManager.ts — Repo Klonlama ve Temizlik

```
clone(owner, repo, installationToken):
1. Gecici dizin olustur: os.tmpdir() + /autodocapi_{owner}_{repo}_{timestamp}/
2. git clone --depth 1 https://x-access-token:{token}@github.com/{owner}/{repo}.git
3. Timeout: max 30 saniye
4. repoPath don

removeSensitiveFiles(repoPath):
Bilinen hassas dosyalari sil (glob ile):
  - .env
  - .env.*
  - *.pem
  - *.key
  - *.pfx
  - *.p12
  - credentials.json
  - service-account.json
  - appsettings.Development.json
  - appsettings.Local.json
NOT: Wildcard isim eslestirme YAPMA (ornek: *secret* → secretRoutes.ts siler).
     Sadece bilinen dosya adi ve uzanti pattern'leri kullan.

cleanup(repoPath):
1. rm -rf repoPath
2. Log: "Repo cleaned up: {repoPath}"

NOT: Cache yok. Her analizde yeniden klonla, bitince hemen sil.
```

### 8.6 src/detector/frameworkDetector.ts — Framework Algilama

```
detect(repoPath, config):

1. config'de framework alani varsa → o degeri don (override)

2. package.json oku (Node.js projesi mi?)
   - dependencies veya devDependencies icinde:
     - "express" → Framework.EXPRESS
     - "@nestjs/core" → Framework.NESTJS

3. *.csproj dosyasi ara (glob: **/*.csproj)
   - Dosya icinde "Microsoft.AspNetCore" referansi varsa:
     - Program.cs veya Startup.cs icinde "MapGet", "MapPost" vb. varsa → Framework.ASPNET_MINIMAL
     - Controllers/ dizini veya [ApiController] attribute varsa → Framework.ASPNET_CONTROLLER
     - Ikisi birden varsa → Framework.ASPNET_BOTH

4. Hicbiri bulunamazsa → hata don ("Desteklenen framework bulunamadi")

NOT: Bir repoda ya JavaScript/TypeScript ya da C# olacak, ikisi birden olmayacak.

enum Framework {
  EXPRESS = "express",
  NESTJS = "nestjs",
  ASPNET_CONTROLLER = "aspnet-controller",
  ASPNET_MINIMAL = "aspnet-minimal",
  ASPNET_BOTH = "aspnet-both",
}
```

### 8.7 src/parser/expressParser.ts — Express Route Parse

```
Babel AST kullanarak Express route'larini cikarir.

parse(repoPath):

1. Tum .ts ve .js dosyalarini bul (asagidaki dizinler HARIC):
   - node_modules/
   - dist/
   - build/
   - test/
   - __tests__/
   - *.test.ts, *.test.js
   - *.spec.ts, *.spec.js

2. Her dosyayi Babel ile parse et (@babel/parser)
   - Parse hatasi olan dosyalar → errors dizisine ekle, devam et

3. AST uzerinde traverse et (@babel/traverse):

   a. app.get/post/put/delete/patch cagrilarini bul:
      - callee: app.get veya router.get vb.
      - 1. arguman: route path string → "/users/:id"
      - Son arguman: handler fonksiyon
      - Aradaki argumanlar: middleware'ler

   b. router.use('/prefix', subRouter) pattern'lerini bul:
      - Import/export isim eslestirmesi ile hangi router'in hangi prefix altinda
        kullanildigini bul
      - Prefix'i ilgili router'in route'larina ekle

   c. Her route icin:
      - Path parametrelerini cikar (":id" → {name: "id", in: "path"})
      - Handler fonksiyonun parametrelerinden req.query, req.body kullanimi tespit et
      - JSDoc comment varsa description olarak al

4. Tip bilgisi cikarma:
   - TypeScript dosyasiysa: req.body tipi, res.json() icindeki tip
   - Interface/type tanimlarini ayni dosya veya import'tan bul
   - Bulunamazsa type: "any" olarak birak

5. Auth/middleware algilama (isim tabanli):
   - Middleware fonksiyon adinda su kelimeler geciyorsa → auth alani doldur:
     "auth", "guard", "protect", "verify", "jwt", "passport", "token"
   - passport.authenticate() cagrisi → auth: "Bearer"
   - Global app.use(authMiddleware) → tum route'lara auth uygula
   - Router seviyesi router.use(verifyToken) → o router'in route'larina auth uygula
   - Inline fonksiyon → algilanamaz, auth alani null kalir
   - Diger middleware'leri middleware dizisine ekle

6. ParseResult formatinda don

Dikkat:
- Dinamik route'lar (degisken ile tanimlanan) yakalanmayabilir → errors dizisine uyari ekle
- Template literal route'lar kismi destek → sabit kismi al, dinamik kismi {dynamic} olarak isaretle
```

### 8.8 src/parser/nestParser.ts — NestJS Route Parse

```
ts-morph kullanarak NestJS route'larini cikarir.

parse(repoPath):

1. ts-morph Project olustur, tsconfig.json yolunu ver

2. Tum .ts dosyalarini tara (test dosyalari haric:
   test/, __tests__/, *.test.ts, *.spec.ts)

3. Her dosyadaki class'lari bul:
   a. @Controller() decorator'u var mi?
      - Varsa → controller prefix'ini al: @Controller('users') → "/users"

   b. Class method'larini tara:
      - @Get(), @Post(), @Put(), @Delete(), @Patch() decorator'lari
      - Decorator parametresi: @Get(':id') → path = "/:id"
      - Tam path = controller prefix + method path

   c. Method parametrelerini tara:
      - @Param('id') → {name: "id", in: "path"}
      - @Query('page') → {name: "page", in: "query"}
      - @Body() → requestBody (DTO tipini al)
      - @Headers('authorization') → {name: "authorization", in: "header"}

   d. Guard/middleware algilama:
      - @UseGuards(AuthGuard) → auth alani
      - Class seviyesinde @UseGuards varsa → tum method'lara uygula

   e. Return tipi:
      - Method return tipi: Promise<User> → response type = "User"
      - User tipinin property'lerini ts-morph ile coz

4. DTO/Entity/Interface cozumleme:
   - ts-morph tip referanslarini takip eder (cross-file)
   - Property'leri, tiplerini ve required/optional bilgisini cikarir
   - Circular dependency korunma: ziyaret edilen tipleri Set<string> ile takip et
     - Ayni tip tekrar cozumlenmeye calisilirsa → donguyu kes, sadece tip ismini ver
     - Ornek: User → Order → User geldiginde ikinci User acilmaz

5. JSDoc comment'leri:
   - Method uzerindeki JSDoc'u description olarak al

6. ParseResult formatinda don
```

### 8.9 src/parser/dotnetBridge.ts — .NET CLI Wrapper

```
.NET Roslyn analyzer'i child process olarak calistirir.

parse(repoPath):

1. analyzer DLL yolunu belirle (env'den: DOTNET_ANALYZER_PATH)

2. child_process.execFile cagir:
   - command: "dotnet"
   - args: [analyzerDllPath, repoPath]
   - options: { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
   - Timeout: restore (60sn) + parse (60sn) = toplam 120sn

3. stdout'u JSON.parse et

4. JSON yapisini ParseResult tipine donustur

5. stderr'de hata varsa → errors dizisine ekle

6. Process timeout olursa → hata don

7. ParseResult formatinda don
```

### 8.10 analyzer/ — .NET Roslyn Projesi

```
CLI uygulamasi: dotnet AutoDocAnalyzer.dll /path/to/repo

Program.cs:
1. Argumandan repo path'i al
2. *.csproj dosyasini bul
3. dotnet restore calistir (max 60sn timeout)
4. Restore basarili → MSBuildWorkspace ile projeyi yukle (tam tip cozumleme)
5. Restore basarisiz → fallback: AdhocWorkspace + SyntaxTree (tip cozumleme yok,
   sadece route + attribute parse)
6. ControllerParser ve MinimalApiParser'i calistir
7. Sonuclari birlestir
8. JSON olarak stdout'a yaz (System.Text.Json, camelCase)
9. Restore basarisiz olduysa errors dizisine uyari ekle:
   "NuGet restore failed — type resolution limited"

ControllerParser.cs:
- [ApiController] attribute'lu class'lari bul
- [Route("api/[controller]")] prefix'ini al
- [HttpGet], [HttpPost], [HttpPut], [HttpDelete] method'lari bul
- [FromBody], [FromQuery], [FromRoute] parametreleri cikar
- [Authorize] attribute → auth alani
- Return tipini coz: ActionResult<T> → T'nin property'leri (cross-file, MSBuildWorkspace ile)
- Circular dependency korunma: ziyaret edilen tipleri HashSet<string> ile takip et
- XML comment varsa → description

MinimalApiParser.cs:
- Program.cs veya Startup.cs'te app.MapGet/MapPost/MapPut/MapDelete cagrilarini bul
- Lambda parametrelerinden tip bilgisi cikar
- [FromBody], [FromQuery] attribute'lari kontrol et
- .RequireAuthorization() → auth alani

Models/RouteInfo.cs:
- TypeScript'teki ParseResult, RouteInfo, ParamInfo vb. tiplerin C# karsiligi
- JSON serialization icin System.Text.Json attribute'lari (camelCase)
```

### 8.11 src/generator/openApiGenerator.ts — OpenAPI Spec Uretici

```
generate(parseResult, options):

options:
  - title: string (varsayilan: repo adi)
  - version: string (git tag veya commit SHA)
  - format: "yaml" (MVP'de sadece YAML)

1. OpenAPI 3.0.3 iskeletini olustur:
   {
     openapi: "3.0.3",
     info: { title, version },
     paths: {},
     components: { schemas: {}, securitySchemes: {} }
   }

2. Her route icin paths objesine ekle:
   - path: route.path ("/api/users/{id}")
   - method: route.method.toLowerCase()
   - parameters: route.params → OpenAPI parameter objesi
   - requestBody: route.requestBody → $ref ile schema referansi
   - responses: route.responses → her status kodu icin response objesi
   - security: route.auth varsa → security requirement
   - description: route.description
   - tags: [route.controller || "default"]

3. Tip/DTO'lari components/schemas'a ekle:
   - Schema isimlendirme: ControllerAdi.TipAdi (ornek: UsersController.UserDto)
   - Her zaman controller prefix'i kullan — cakisma riski sifir
   - properties: PropertyInfo[] → OpenAPI property objesi
   - required: required=true olan property isimleri dizisi

4. Auth varsa securitySchemes ekle:
   - "Bearer" → bearerAuth (http, bearer, JWT)
   - "ApiKey" → apiKeyAuth (apiKey, header)

5. Server bilgisi ekleme → spec'e server objesi EKLENMEZ
   - Kullanici nerede deploy ettigini biliyor
   - Base URL post-MVP'de .autodoc.yml ile eklenebilir

6. js-yaml ile YAML string'e donustur

7. Spec string'i don

Gerekli npm paketleri: js-yaml
```

### 8.12 src/github/prService.ts — PR Olusturma

```
createPR(owner, repo, spec, parseResult, options):

0. On kontrol (analiz baslamadan once cagrilir):
   - GET /repos/{owner}/{repo} → permissions.push kontrolu
   - Repo archived mi kontrolu
   - Yetersizse → analizi baslatma, DB'ye "permission_denied" kaydet

1. Installation token al (appAuth.getValidToken ile — suresi dolmussa yenile)

2. Git tag bilgisini al:
   - GET /repos/{owner}/{repo}/tags → commit SHA ile eslesen tag var mi?
   - Varsa → version = tag (v1.2.3 → 1.2.3)
   - Yoksa → version = commit SHA kisaltmasi (abc1234)

3. Mevcut default branch'i al (GET /repos/{owner}/{repo})

4. Default branch'in son commit SHA'sini al

5. Yeni branch olustur:
   - Isim: "autodocapi/docs-YYYY-MM-DD-HHmmss"
   - POST /repos/{owner}/{repo}/git/refs
   - ref: "refs/heads/{branchName}"
   - sha: default branch'in son commit SHA'si
   - Timeout: max 15 saniye

6. Dosyayi olustur veya guncelle:
   - PUT /repos/{owner}/{repo}/contents/{docsPath}
   - path: options.docsOutput || "docs/openapi.yaml"
   - message: "docs: update API documentation (AutoDocAPI)"
   - content: Base64 encoded spec
   - branch: branchName
   - Dosya zaten varsa: onceki dosyanin SHA'sini al ve gonder

7. PR ac:
   - POST /repos/{owner}/{repo}/pulls
   - title: "docs: API documentation update — {version}"
   - body: description (asagidaki format)
   - head: branchName
   - base: default branch
   - Dil: Ingilizce

8. PR numarasi ve URL'ini don

PR Description formati:
   ## API Documentation Generated

   **Version:** {version}
   **Endpoints found:** {count}

   | Method | Path |
   |--------|------|
   | GET    | /api/users |
   | POST   | /api/users |
   | ...    | ...        |

   {eger parse hatalari varsa:}
   ### Parse Warnings
   - src/routes/legacy.js — dynamic route pattern not supported

   ---
   > Your source code has been deleted from our servers immediately after analysis.

Hata durumunda:
- Parse kismi basariliysa: PR ac, description'da hatalari raporla
- Parse tamamen basarisizsa: PR acma, DB'ye hata kaydet
```

### 8.13 src/api/healthHandler.ts — Saglik Kontrolu

```
GET /health

Response:
{
  status: "ok" | "error",
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
  checks: {
    database: "ok" | "error",
    dotnetSdk: "ok" | "error"
  }
}

- database: basit SELECT 1 sorgusu
- dotnetSdk: "dotnet --version" exec kontrolu
```

### 8.14 src/config/autodocConfig.ts — .autodoc.yml Okuyucu

```
loadConfig(repoPath):

1. {repoPath}/.autodoc.yml dosyasini oku
2. Yoksa → null don (varsayilanlar kullanilacak)
3. Varsa → YAML parse et (js-yaml)
4. AutoDocConfig objesi don:

interface AutoDocConfig {
  framework?: "express" | "nestjs" | "aspnet";
  docsOutput?: string;   // varsayilan: "docs/openapi.yaml"
}

MVP'de sadece bu iki alan desteklenir.
Diger alanlar (entry_points, format, base_url, target_branch,
api.title, api.description, exclude) post-MVP'de eklenir.
```

### 8.15 src/utils/logger.ts — Loglama

```
Pino logger yapilandirmasi:

Seviyeler:
- info: webhook geldi, analiz basladi, analiz tamamlandi, PR acildi
- warn: kismi parse, rate limit uyarisi
- error: parse hatasi, GitHub API hatasi, klonlama basarisiz, DB hatasi

Format: JSON (yapisal)

Her log girisinde:
- timestamp
- level
- message
- context: { owner, repo, commitSha } (varsa)

Ortama gore:
- development: pino-pretty ile okunabilir konsol ciktisi
- production: JSON dosyaya yazma
```

### 8.16 src/utils/rateLimiter.ts — Rate Limiting

```
Basit in-memory rate limiter.

checkLimit(repoFullName):
- Repo bazli saat basina max istek sayisi (env'den: RATE_LIMIT_PER_HOUR, varsayilan: 10)
- Sliding window algoritmasi
- Limit asildiysa false don
- Asilmadiysa sayaci artir, true don
```

---

## 9. Guvenlik ve Koruma

| Konu | Uygulama |
|---|---|
| Webhook dogrulama | Her istekte `X-Hub-Signature-256` HMAC SHA256 kontrolu. Eslesmezse 401. |
| Rate limiting | Repo bazli saat basina max 10 analiz. In-memory sliding window. |
| Eszamanlilik | Max N paralel analiz (env'den: MAX_CONCURRENT_ANALYSES, varsayilan: 3). In-memory kuyruk. |
| Debounce | Ayni repo icin kuyrukta bekleyen varsa eskiyi cikar, yenisini ekle. Calisan analizi bolme. |
| Yetki kontrolu | PR acmadan once repo'ya push yetkisi + archived kontrolu. Yetersizse analiz baslatma. |
| Repo erisimi | Sadece GitHub App izin sistemi ile. Kullanici onay verdigi repolar. |
| Clone guvenligi | Shallow clone (--depth 1). |
| Hassas dosya silme | Clone sonrasi bilinen hassas dosyalari sil (.env, *.pem, *.key, credentials.json vb). Wildcard isim eslestirme YAPMA. |
| Temp dosyalar | Analiz bitince hemen silinir. |
| Veri gizliligi | Kaynak kod analiz sonrasi sunucudan hemen silinir. Spec DB'de saklanir. |
| Token guvenligi | GitHub installation token DB'de saklanir, suresi dolmadan yenilenir (5dk tampon). |
| Token yenileme | PR acmadan hemen once token gecerliligi kontrol edilir. |
| Env degiskenleri | .env dosyasi .gitignore'da. Production'da environment variable. |

---

## 10. Timeout Yonetimi

Adim bazli timeout uygulanir:

| Adim | Timeout | Aciklama |
|---|---|---|
| git clone | 30 saniye | Shallow clone, buyuk repolarda bile yeterli |
| dotnet restore (.NET) | 60 saniye | NuGet paketleri indirme |
| AST parse | 60 saniye | Tum parser'lar icin |
| PR acma (GitHub API) | 15 saniye | Branch + commit + PR |

Her adim kendi timeout'u ile calisir. Hangi adimda tikandigini loglara yazar.

---

## 11. PR Davranisi

| Konu | Deger |
|---|---|
| Tetiklenme | Her basarili deploy sonrasi (workflow_run completed + success) |
| Branch adi | `autodocapi/docs-YYYY-MM-DD-HHmmss` |
| Varsayilan dosya yolu | `docs/openapi.yaml` |
| Dosya yolu override | `.autodoc.yml` → `docs_output` alani |
| Dosya formati | YAML |
| PR title | `docs: API documentation update — {version}` |
| PR description | Endpoint listesi (method + path tablosu) — Ingilizce |
| PR footer | `"Your source code has been deleted from our servers immediately after analysis."` |
| PR hedef branch | Repo default branch |
| Hata durumu | Kismi sonucla PR ac + parse edilemeyen dosyalari description'da raporla |
| Versiyon | GitHub API ile tag al (v1.2.3 → 1.2.3), yoksa commit SHA (abc1234) |
| Tamamen basarisiz | PR acma, DB'ye hata kaydet |
| Debounce | Ayni repo icin kisa surede birden fazla deploy → sadece son webhook islenir |

---

## 12. Konfigurasyon Dosyalari

### 12.1 .env.example

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/autodocapi

# GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# .NET Analyzer
DOTNET_ANALYZER_PATH=./analyzer/bin/Release/net8.0/AutoDocAnalyzer.dll

# Limits
MAX_CONCURRENT_ANALYSES=3
RATE_LIMIT_PER_HOUR=10

# Timeouts (ms)
CLONE_TIMEOUT_MS=30000
RESTORE_TIMEOUT_MS=60000
PARSE_TIMEOUT_MS=60000
PR_TIMEOUT_MS=15000

# Logging
LOG_LEVEL=info
```

### 12.2 .autodoc.yml (Kullanici Repo'sunda — Opsiyonel)

```yaml
# MVP'de sadece bu iki alan desteklenir
framework: express       # express | nestjs | aspnet
docs_output: docs/openapi.yaml
```

### 12.3 drizzle.config.ts

```typescript
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

### 12.4 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "analyzer"]
}
```

### 12.5 jest.config.ts

```typescript
import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/db/migrations/**"],
};

export default config;
```

---

## 13. CI/CD Pipeline

### .github/workflows/deploy.yml

```yaml
name: Test & Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/autodocapi
            git pull origin main
            npm ci --production
            npm run build
            cd analyzer
            dotnet publish -c Release
            cd ..
            pm2 restart autodocapi
```

---

## 14. Test Stratejisi

**Yaklasim:** Unit test — her parser fonksiyonu ayri ayri test edilir.

### 14.1 Express Parser Testleri (test/parser/expressParser.test.ts)

```
Test case'ler:
- Basit GET route: app.get('/users', handler) → route bulunur
- Parametreli route: app.get('/users/:id', handler) → path param cikarilir
- Birden fazla method: GET, POST, PUT, DELETE → hepsi bulunur
- Router prefix: router.use('/api', subRouter) → prefix eklenir
- Middleware algilama: app.get('/users', auth, handler) → middleware dizisinde "auth"
- Auth middleware algilama: fonksiyon adinda "auth" gecen → auth alani dolar
- Global auth middleware: app.use(authMiddleware) → tum route'lara uygulanir
- TypeScript tip cikarma: req: Request<{id: string}> → param tipi
- JSDoc description: /** Get user */ → description alani dolar
- Dinamik route uyarisi: app.get(dynamicPath, handler) → errors dizisinde uyari
- Bos dosya: hicbir route yok → bos dizi
- Test dosyalari haric tutulur: *.test.ts, *.spec.ts icindeki mock route'lar yakalanmaz
```

### 14.2 NestJS Parser Testleri (test/parser/nestParser.test.ts)

```
Test case'ler:
- Basit controller: @Controller('users') + @Get() → route bulunur
- Parametreli route: @Get(':id') + @Param('id') → path param cikarilir
- DTO request body: @Body() dto: CreateUserDto → requestBody dolar
- Response tipi: Promise<User> → response tipi cikarilir
- Guard algilama: @UseGuards(AuthGuard) → auth alani dolar
- Class seviyesi guard: tum method'lara uygulanir
- Nested DTO: DTO icinde baska DTO referansi → property'ler cozulur
- Circular dependency: User → Order → User → dongu kesilir, sonsuz dongu olmaz
- Multiple controllers: ayni dosyada iki controller → ikisi de bulunur
- Test dosyalari haric tutulur
```

### 14.3 .NET Bridge Testleri (test/parser/dotnetBridge.test.ts)

```
Test case'ler:
- CLI basarili cikti → ParseResult donusumu dogru
- CLI hata ciktisi → errors dizisine eklenir
- CLI timeout → hata don
- Gecersiz JSON ciktisi → hata don
```

### 14.4 OpenAPI Generator Testleri (test/generator/openApiGenerator.test.ts)

```
Test case'ler:
- Basit route → gecerli OpenAPI 3.0.3 spec uretilir
- Parametreli route → parameters dizisi dogru
- Request body → requestBody + schema ref dogru
- Response tipleri → responses + schema ref dogru
- Auth → securitySchemes eklenir
- Bos ParseResult → bos paths objesi
- YAML format → gecerli YAML string
- Version bilgisi → info.version dogru
- Schema isimlendirme → ControllerAdi.TipAdi formati dogru
- Ayni isimli farkli DTO'lar → farkli schema isimleri
```

### 14.5 Framework Detector Testleri (test/detector/frameworkDetector.test.ts)

```
Test case'ler:
- package.json'da express → Framework.EXPRESS
- package.json'da @nestjs/core → Framework.NESTJS
- .csproj dosyasi + Controllers/ → Framework.ASPNET_CONTROLLER
- .csproj dosyasi + MapGet → Framework.ASPNET_MINIMAL
- .autodoc.yml override → config degeri oncelikli
- Hicbiri bulunamadi → hata
```

---

## 15. npm Paketleri

### dependencies
```
express                    - Web framework
@octokit/app              - GitHub App auth
@octokit/rest             - GitHub REST API client
@babel/parser             - JavaScript/TypeScript AST parse
@babel/traverse           - AST traversal
ts-morph                  - TypeScript AST (NestJS icin)
drizzle-orm               - ORM
pg                        - PostgreSQL driver
pino                      - Logger
pino-http                 - Express icin HTTP logger
js-yaml                   - YAML parse/stringify
dotenv                    - Environment variables
jsonwebtoken              - GitHub App JWT olusturma
```

### devDependencies
```
typescript                - TypeScript compiler
@types/express            - Express tipleri
@types/node               - Node.js tipleri
@types/pg                 - pg tipleri
@types/js-yaml            - js-yaml tipleri
@types/jsonwebtoken       - jsonwebtoken tipleri
drizzle-kit               - Migration CLI
jest                      - Test runner
ts-jest                   - TypeScript Jest transform
@types/jest               - Jest tipleri
pino-pretty               - Dev ortaminda okunabilir log
```

---

## 16. Gelistirme Sirasi (Build Order)

Projeyi su sirada gelistir:

### Faz 1: Altyapi
1. Proje olustur: `npm init`, `tsconfig.json`, `.gitignore`, `.env.example`
2. Express app iskeletini kur (`src/app.ts` + `src/api/routes.ts`)
3. Pino logger yapilandir (`src/utils/logger.ts`)
4. PostgreSQL baglantisi + Drizzle schema (installations, repos, analyses, webhook_events) + migration (`src/db/`)
5. Health endpoint (`GET /health`)

### Faz 2: GitHub Entegrasyonu
6. GitHub App auth modulu (`src/github/appAuth.ts`) — JWT + token yenileme (5dk tampon)
7. Webhook handler: signature dogrulama + event filtreleme (`src/api/webhookHandler.ts`)
8. Repo Manager: clone + hassas dosya silme + cleanup (`src/github/repoManager.ts`)
9. Rate limiter (`src/utils/rateLimiter.ts`)
10. Analiz kuyrugu + debounce (`src/queue/analysisQueue.ts`)

### Faz 3: Parser'lar
11. Ortak tipler tanimla (`src/parser/types.ts`)
12. Framework detector (`src/detector/frameworkDetector.ts`)
13. Express parser — tum dosyalari tara, test dosyalari haric (`src/parser/expressParser.ts`) + unit testler
14. NestJS parser — circular dependency korunma dahil (`src/parser/nestParser.ts`) + unit testler
15. .NET Roslyn analyzer projesi — MSBuildWorkspace + fallback (`analyzer/`) + build
16. .NET bridge (`src/parser/dotnetBridge.ts`) + unit testler

### Faz 4: Cikti Uretimi
17. OpenAPI generator — Controller.TypeName schema isimlendirme (`src/generator/openApiGenerator.ts`) + unit testler
18. PR service — yetki kontrolu + token yenileme + tag alma + PR olusturma (`src/github/prService.ts`)

### Faz 5: Birlestirme ve Teslimat
19. Ana pipeline'i birlestir: webhook → debounce → yetki kontrol → clone → hassas dosya sil → detect → parse → generate → PR → cleanup
20. Config loader (`.autodoc.yml`) (`src/config/autodocConfig.ts`)
21. Uc-uca test: ornek repo ile tam akis testi
22. CI/CD pipeline (`.github/workflows/deploy.yml`)
23. VPS kurulumu: Node.js + .NET SDK + PostgreSQL + PM2

---

## 17. Ortam Yonetimi

```
Aktif ortamlar:
- Local (development) → NODE_ENV=development
- Production → NODE_ENV=production

Altyapi ortam agnostik: .env dosyasindan tum konfigurasyon okunur.
Ileride UAT gerekirse yeni .env + sunucu eklemek yeterli.

Development ozellikleri:
- pino-pretty ile okunabilir konsol ciktisi
- Detayli hata mesajlari
- DB: lokal PostgreSQL

Production ozellikleri:
- JSON log dosyasina yazma
- Kisitli hata mesajlari (stack trace disariya verilmez)
- DB: VPS uzerindeki PostgreSQL
- PM2 ile process yonetimi
```

---

## 18. VPS Kurulum Gereksinimleri (Hostinger)

```
Sunucu uzerinde kurulu olmasi gerekenler:
- Node.js 20 LTS
- .NET SDK 8
- PostgreSQL 16
- PM2 (npm install -g pm2)
- Git
- Nginx (reverse proxy + SSL — onerilir)

Dizin yapisi:
/opt/autodocapi/           → proje kodu
/var/log/autodocapi/       → log dosyalari

PM2 yapilandirmasi:
pm2 start dist/app.js --name autodocapi

Nginx reverse proxy:
- api.autodocapi.com → localhost:3000
- SSL: Let's Encrypt (certbot)
```

---

## 19. GitHub App Marketplace Ayarlari

```
App ismi: AutoDocAPI
Aciklama: Automatically generate OpenAPI documentation from your source code after every successful deploy.

Gerekli izinler:
- Repository permissions:
  - Contents: Read & Write (repo klonlama + dosya commit)
  - Pull requests: Read & Write (PR olusturma)
  - Metadata: Read-only (repo bilgisi)

Webhook:
- URL: https://api.autodocapi.com/webhook/github
- Secret: GITHUB_WEBHOOK_SECRET env variable ile eslesir
- Events: Workflow run

Guvenlik notu (Marketplace sayfasinda):
"Your source code is only kept on our server during analysis.
 It is deleted immediately after the analysis is complete.
 Your code is never stored, shared, or used for any other purpose."
```

---

## 20. MVP vs Post-MVP Kapsam

### MVP (ilk surum)
- [x] Express parser (JS + TS) — tum dosyalari tara, test dosyalari haric
- [x] NestJS parser — circular dependency korunma dahil
- [x] ASP.NET Core parser (Controller + Minimal API) — MSBuildWorkspace + fallback
- [x] GitHub App (webhook dinleme)
- [x] Otomatik framework algilama
- [x] Minimal .autodoc.yml (framework + docs_output)
- [x] OpenAPI 3.0.3 spec uretimi (YAML)
- [x] PR olusturma (endpoint listesi + guvenlik notu) — Ingilizce
- [x] Rate limiting (repo bazli)
- [x] Max N paralel analiz (in-memory kuyruk)
- [x] Debounce (ayni repo icin son webhook)
- [x] Yetki kontrolu (PR acmadan once)
- [x] Token yenileme (5dk tampon ile)
- [x] Hassas dosya silme (clone sonrasi)
- [x] Adim bazli timeout
- [x] Yapisal loglama (Pino)
- [x] Health endpoint
- [x] Unit testler
- [x] GitHub Actions CI/CD
- [x] Kismi sonuc raporlama
- [x] Analiz sonrasi repo hemen silinir
- [x] Schema isimlendirme: Controller.TypeName
- [x] Git tag → GitHub API ile alma

### Post-MVP
- [ ] Diff engine (eklenen/silinen/degisen endpoint karsilastirma)
- [ ] Repo cache (TTL ile)
- [ ] Genis .autodoc.yml (entry_points, format, base_url, target_branch, api title/desc, exclude)
- [ ] JSON cikti formati destegi
- [ ] Metrics endpoint (GET /metrics)
- [ ] GitHub OAuth + web dashboard
- [ ] Monorepo destegi
- [ ] Birlesik API portal
- [ ] Ek diller: Python (FastAPI, Flask, Django)
- [ ] Ek diller: Go (Gin, Echo)
- [ ] Ek diller: Java (Spring Boot)
- [ ] Breaking change bildirimi (email, Slack)
- [ ] UAT ortami
- [ ] RabbitMQ kuyruk (in-memory yerine)
- [ ] Kullanici bazli analiz limitleri (pricing)
- [ ] Webhook retry mekanizmasi
