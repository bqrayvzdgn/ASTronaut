# ASTronaut — Proje Plani

> Projeyi sifirdan uretmek icin gereken tum kararlar, teknik detaylar ve uygulama talimatlari.

---

## 1. Ne Yapar?

Kullanicinin backend projesini AST ile okuyup OpenAPI 3.0.3 spec uretir. Iki tetikleme modu var:

| Mod | Nasil | Sonuc |
|---|---|---|
| **Otomatik** | GitHub App — deploy basarili olunca webhook tetikler | Repo'ya PR acar |
| **Manuel** | CLI — `npx astronaut analyze` | Terminale veya dosyaya yazar |

**Temel kural:** AI yok, tahmin yok. Kodda ne varsa o. Analiz biter bitmez kaynak kod sunucudan silinir.

---

## 2. Stack

| Katman | Teknoloji |
|---|---|
| Runtime | Node.js 20 LTS |
| Dil | TypeScript 5.x |
| HTTP Server | Express 4.x |
| AST (JS/TS) | Babel (@babel/parser + @babel/traverse) |
| AST (C#) | Roslyn (.NET 8, child process) |
| AST (Go) | go/parser + go/ast (Go 1.21+, child process) |
| DB | PostgreSQL 16 + Drizzle ORM |
| GitHub API | Octokit (@octokit/app + @octokit/rest) |
| Auth | jsonwebtoken (RS256 JWT) |
| Log | Pino |
| Test | Jest + ts-jest |
| Config | dotenv + js-yaml (.autodoc.yml) |

---

## 3. Framework Destegi

| Framework | Dil | Parser | Entegrasyon |
|---|---|---|---|
| Express | JS/TS | Babel AST | In-process |
| Gin | Go | go/parser + go/ast | Child process (`analyzers/gin/`) |
| ASP.NET Core | C# | Roslyn MSBuildWorkspace | Child process (`analyzers/dotnet/`) |

### Her Parser Ne Cikarir?

- Route path ve HTTP method
- Path / query / header parametreleri
- Request body tipi ve property'leri
- Response tipleri
- Auth middleware tespiti
- Middleware listesi
- JSDoc / XML doc / Go comment description
- Kaynak dosya yolu

---

## 4. Mimari

### 4.1 Moduler Registry

Pipeline hicbir parser'i direkt bilmez. Sadece registry'yi cagirir.

```
Pipeline → detectAndParse(repoPath, config)
               |
               Registry
               ├── expressModule  (detect: package.json → "express")
               ├── aspnetModule   (detect: .csproj → "Microsoft.AspNetCore")
               └── ginModule      (detect: go.mod → "gin-gonic/gin")
```

**FrameworkModule interface:**
```typescript
interface FrameworkModule {
  readonly id: string;
  readonly name: string;
  readonly languages: readonly string[];
  detect(repoPath: string): Promise<number>;  // 0=hayir, 1+=evet
  parse(repoPath: string): Promise<ParseResult>;
}
```

**Yeni framework eklemek:** Modul dosyasi yaz + `modules/index.ts`'e import ekle. Bitti.

### 4.2 Pipeline (Webhook Modu)

```
Webhook gelir
  → Imza dogrula (HMAC-SHA256)
  → Rate limit kontrol
  → Kuyruğa ekle (debounce)
  → processAnalysis:
      1. Installation token al (DB cache, 5dk tampon ile yenile)
      2. Repo izin kontrol (push + archived degil)
      3. Clone (depth=1, temp dizine)
      4. Hassas dosyalari sil
      5. .autodoc.yml varsa oku
      6. detectAndParse() — framework algila + parse
      7. OpenAPI YAML uret
      8. PR ac (branch + commit + PR)
      9. DB'ye kaydet
     10. Clone'u sil
```

### 4.3 CLI Modu

```
astronaut analyze [path] [--framework X] [--format yaml|json] [--output file]
  → Parser modulleri yukle
  → .autodoc.yml oku (varsa)
  → detectAndParse()
  → OpenAPI spec uret
  → stdout veya dosyaya yaz
```

---

## 5. Dosya Yapisi

```
src/
  app.ts                        # Express server + graceful shutdown
  cli/
    index.ts                    # CLI entry point (npx astronaut analyze)
  api/
    routes.ts                   # Route tanimlari
    webhookHandler.ts           # Webhook alici (imza, dispatch, rate limit)
    healthHandler.ts            # GET /health
  parser/
    types.ts                    # ParseResult, RouteInfo, FrameworkModule
    registry.ts                 # registerFramework, detectAndParse
    modules/
      index.ts                  # Barrel (tum modulleri import eder)
      expressModule.ts          # Express detect + parse
      aspnetModule.ts           # ASP.NET detect + parse
      ginModule.ts              # Gin detect + parse
    expressParser.ts            # Babel AST parser
    dotnetBridge.ts             # .NET child process bridge
    ginBridge.ts                # Go child process bridge
  generator/
    openApiGenerator.ts         # ParseResult → OpenAPI 3.0.3 YAML
  github/
    appAuth.ts                  # JWT + installation token (cache + refresh)
    repoManager.ts              # Clone + hassas dosya silme + cleanup
    prService.ts                # Izin kontrol + branch + commit + PR
  config/
    index.ts                    # Env vars + validation
    autodocConfig.ts            # .autodoc.yml okuyucu
  db/
    connection.ts               # Drizzle + pg baglantisi
    schema.ts                   # 4 tablo: installations, repos, analyses, webhook_events
  pipeline/
    index.ts                    # Pipeline init + stale webhook replay
    processAnalysis.ts          # Ana orkestrasyon (10 adim)
  queue/
    analysisQueue.ts            # In-memory FIFO (concurrency + debounce + drain)
  utils/
    logger.ts                   # Pino (child logger destegi)
    rateLimiter.ts              # Sliding window (1 saat, repo bazli)
    retryPolicy.ts              # Exponential backoff (GitHub API + git clone)
    withTimeout.ts              # Promise timeout wrapper

analyzers/
  dotnet/                       # .NET 8 Roslyn projesi
    ASTronautAnalyzer.csproj
    Program.cs                  # MSBuildWorkspace + fallback
    Parsers/
      ControllerParser.cs       # [ApiController] + [HttpGet] vb.
      MinimalApiParser.cs       # app.MapGet() vb.
    Models/
      RouteInfo.cs
  gin/                          # Go AST projesi
    go.mod
    main.go                     # go/parser ile Gin route parse

test/                           # src/ ile ayni yapida (14 suite, 189 test)
scripts/
  test-parser.ts                # Manuel parser test
```

---

## 6. Veritabani

4 tablo (Drizzle ORM + PostgreSQL):

**installations** — GitHub App kurulumu
```
id, githubInstallationId (unique), owner, accessToken, tokenExpiresAt, createdAt, updatedAt
```

**repos** — Kuruluma bagli repo'lar
```
id, installationId (FK), repoName, repoFullName, isActive (bool), createdAt
Index: repo_full_name
```

**analyses** — Her analiz sonucu
```
id, repoId (FK), commitSha, tag, spec (full YAML), status (success|partial|failed),
errors (jsonb), endpointCount, prNumber, prUrl, durationMs, createdAt
Index: repo_id
```

**webhook_events** — Gelen webhook'lar
```
id, eventType, action, repoFullName, payload (jsonb),
processed (pending|processing|done|skipped|error), processedAt, errorMessage, createdAt
```

---

## 7. Ortak Tipler

Tum parser'lar ayni `ParseResult` uretir:

```typescript
ParseResult { routes: RouteInfo[], errors: ParseError[] }

RouteInfo {
  path, method, controller, routePrefix,
  params: ParamInfo[],
  requestBody: RequestBodyInfo | null,
  responses: ResponseInfo[],
  auth, middleware[], description, source
}

ParamInfo { name, in (path|query|header|cookie), type, required }
RequestBodyInfo { type, contentType?, properties[] }
ResponseInfo { status, type, properties[] }
PropertyInfo { name, type, required }
ParseError { file, reason }
```

---

## 8. Parser Detaylari

### Express (1058 satir)
- Babel AST, iki gecisli traversal
- 1\. gecis: router/app degisken tespiti + middleware
- 2\. gecis: route extraction (path, params, body, query, auth)
- `app.use('/prefix', router)` mount map cozumleme
- TypeScript `Request<P,Res,Req,Q>` generic tip cikarma
- Auth keyword tespiti: auth, guard, protect, jwt, passport, token

### ASP.NET (dotnetBridge → analyzers/dotnet/)
- Child process: `dotnet analyzer.dll <repoPath>`
- `dotnet restore` → MSBuildWorkspace (basarisiz → syntax-only fallback)
- ControllerParser: `[ApiController]`, `[HttpGet]`, `[FromBody]` vb.
- MinimalApiParser: `app.MapGet()`, `app.MapPost()` vb.
- Route deduplication (method:path)

### Gin (ginBridge → analyzers/gin/)
- Child process: `gin-analyzer <repoPath>`
- Go standart `go/parser` + `go/ast`
- `r.GET()`, `r.POST()`, `r.Group("/prefix")` parse
- Iki gecisli: once Group prefix'leri topla, sonra route'lari cikar
- `:id` → `{id}`, `*action` → `{action}` donusumu
- Middleware ve auth tespiti

---

## 9. OpenAPI Generator

- `ParseResult` → OpenAPI 3.0.3 YAML
- Tip esleme: int→integer, bool→boolean, float→number
- Route constraint temizleme: `{id:guid}` → `{id}`
- OperationId: controller + method + path
- Schema isimlendirme: Controller.TypeName
- Security scheme (auth varsa)
- Versiyon: git tag veya commit SHA

---

## 10. Guvenlik

| Onlem | Uygulama |
|---|---|
| Webhook dogrulama | HMAC-SHA256, constant-time karsilastirma |
| Rate limiting | Repo bazli sliding window (10/saat) |
| Concurrency | Max 3 paralel analiz |
| Yetki | Push izni + archived degil |
| Token | DB cache, 5dk tampon ile yenileme, concurrent dedup |
| Hassas dosya | .env, *.pem, *.key, credentials.json silme |
| Kod temizligi | Analiz bitince repo hemen silinir |
| Path guvenlik | .autodoc.yml docs_output: traversal, absolute, null byte engeli |
| Clone guvenlik | Owner/repo regex validasyonu |

---

## 11. Kuyruk

In-memory FIFO (`AnalysisQueue` class):

| Ozellik | Deger |
|---|---|
| Max paralel | 3 (`MAX_CONCURRENT_ANALYSES`) |
| Max kuyruk | 100 (`MAX_QUEUE_SIZE`) |
| Job timeout | 600s (`JOB_TIMEOUT_MS`) |
| Debounce | Ayni repo icin son webhook |
| Shutdown | `drain()` — aktif isler bitmesini bekle (30s timeout) |
| Replay | Startup'ta stale webhook'lari DB'den tekrar kuyruga ekle |

---

## 12. PR Davranisi

| Konu | Deger |
|---|---|
| Branch | `astronaut/docs-YYYYMMDD-HHMMSS-XXXX` |
| Dosya | `docs/openapi.yaml` (veya .autodoc.yml override) |
| Title | `docs: API documentation update — {version}` |
| Body | Versiyon, endpoint sayisi, endpoint tablosu, uyarilar |
| Footer | Guvenlik notu (kod silindi) |
| Versiyon | Git tag (v1.2.3 → 1.2.3) veya commit SHA |
| Kismi sonuc | Bulunan route'larla PR ac + hatalari raporla |
| 0 route | PR acma, DB'ye failed kaydet |

---

## 13. Timeout'lar

| Adim | Env Var | Default |
|---|---|---|
| Clone | `CLONE_TIMEOUT_MS` | 90s |
| .NET restore | `RESTORE_TIMEOUT_MS` | 120s |
| Parse | `PARSE_TIMEOUT_MS` | 120s |
| PR | `PR_TIMEOUT_MS` | 30s |
| Toplam job | `JOB_TIMEOUT_MS` | 600s |

Retry: GitHub API → 3 deneme (1-4s backoff). Git clone → 2 deneme (2-4s backoff).

---

## 14. Konfigurasyon

### Env Vars
```
PORT=3000                    NODE_ENV=development
DATABASE_URL=...             DB_POOL_MAX=10
GITHUB_APP_ID=...            GITHUB_APP_PRIVATE_KEY_PATH=...
GITHUB_WEBHOOK_SECRET=...
DOTNET_ANALYZER_PATH=./analyzers/dotnet/bin/Release/net8.0/ASTronautAnalyzer.dll
GIN_ANALYZER_PATH=./analyzers/gin/bin/gin-analyzer
MAX_CONCURRENT_ANALYSES=3    RATE_LIMIT_PER_HOUR=10    MAX_QUEUE_SIZE=100
CLONE_TIMEOUT_MS=90000       RESTORE_TIMEOUT_MS=120000
PARSE_TIMEOUT_MS=120000      PR_TIMEOUT_MS=30000       JOB_TIMEOUT_MS=600000
LOG_LEVEL=info
```

### .autodoc.yml (opsiyonel, kullanici repo'sunda)
```yaml
framework: express    # express | aspnet | gin (registry module id)
docs_output: docs/openapi.yaml
```

---

## 15. CLI

```bash
astronaut analyze [path] [options]

Options:
  -f, --framework <name>   # Framework zorla (express|aspnet|gin)
  -o, --output <file>      # Dosyaya yaz (default: stdout)
      --format <yaml|json>  # Cikti formati (default: yaml)
  -h, --help
  -v, --version
```

- Sunucuya, DB'ye, GitHub'a gerek yok — tamamen local
- Ayni parser + generator + registry'yi kullanir
- Spec version: git tag veya commit SHA
- Ozet: route sayisi, uyarilar, sure (stderr)

---

## 16. Test

14 test suite, 189 test. Jest + ts-jest.

| Suite | Kapsam |
|---|---|
| expressParser | Route, param, body, auth, middleware, TS generic |
| dotnetBridge | Child process, JSON parse, timeout, hata |
| registry | Kayit, duplicate, detection, config override |
| cli/index | Help, version, YAML, JSON, file output, error |
| openApiGenerator | YAML uretim, tip esleme, schema, security |
| webhookHandler | Imza, event dispatch, rate limit |
| appAuth | JWT, token cache, yenileme |
| prService | Izin, branch, commit, PR |
| repoManager | Clone, hassas dosya, cleanup |
| processAnalysis | Full pipeline, hata, cleanup |
| analysisQueue | Kuyruk, debounce, concurrency |
| autodocConfig | YAML parse, path guvenlik |
| rateLimiter | Sliding window, eviction |
| retryPolicy | Backoff, transient error |

Coverage thresholds: 60% branch, 70% function/line/statement.

---

## 17. GitHub App

```
Izinler:
  Contents: Read & Write
  Pull requests: Read & Write
  Metadata: Read-only

Webhook:
  Event: workflow_run
  Secret: GITHUB_WEBHOOK_SECRET

Guvenlik notu:
"Your source code is only kept on our server during analysis.
 It is deleted immediately after the analysis is complete."
```

---

## 18. Gereksinimler

| Gereksinim | Versiyon |
|---|---|
| Node.js | 20 LTS |
| .NET SDK | 8.0 |
| Go | 1.21+ |
| PostgreSQL | 16 |
| PM2 | latest (production) |

---

## 19. Build & Deploy

```bash
# TypeScript build
npm run build

# .NET analyzer build
cd analyzers/dotnet && dotnet publish -c Release

# Go analyzer build
cd analyzers/gin && go build -o bin/gin-analyzer .

# Production
pm2 start dist/app.js --name astronaut
```

---

## 20. Gelecek Planlar

- [ ] Diff engine (eklenen/silinen endpoint karsilastirma)
- [ ] Repo cache (TTL)
- [ ] Genis .autodoc.yml (entry_points, base_url, exclude)
- [ ] Metrics endpoint (GET /metrics)
- [ ] GitHub OAuth + web dashboard
- [ ] Monorepo destegi
- [ ] Python (FastAPI, Flask, Django) parser
- [ ] Java (Spring Boot) parser
- [ ] Breaking change bildirimi (email, Slack)
- [ ] RabbitMQ kuyruk (in-memory yerine)
- [ ] Kullanici bazli limitler (pricing)
