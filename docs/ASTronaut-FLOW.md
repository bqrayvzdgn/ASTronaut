# ASTronaut — Detayli Akis Dokumani

> Bu dokuman, ASTronaut'nin bastan sona calisma akisini adim adim gosterir.
> Her faz, her karar noktasi ve her hata senaryosu detayli olarak aciklanmistir.

---

## Faz 0: Kullanici GitHub App'i Kuruyor (Tek Seferlik)

```
Kullanici → GitHub Marketplace → "ASTronaut" → Install
    |
    v
GitHub izin ekrani:
+----------------------------------------------+
|  ASTronaut is requesting access to:          |
|                                               |
|  [x] Read access to code                     |
|  [x] Read and write access to pull requests  |
|  [x] Read access to metadata                 |
|                                               |
|  Install on:                                  |
|  ( ) All repositories                         |
|  (x) Only select repositories                |
|    [x] my-org/payment-api                    |
|    [x] my-org/user-service                   |
|                                               |
|  [Install]  [Cancel]                          |
+----------------------------------------------+
    |
    v  Kullanici "Install" tikladi
    |
    v
GitHub → ASTronaut backend'e webhook gonderir:
    POST /webhook/github
    x-github-event: installation
    payload: {
      action: "created",
      installation: { id: 12345, account: { login: "my-org" } },
      repositories: [
        { name: "payment-api", full_name: "my-org/payment-api" },
        { name: "user-service", full_name: "my-org/user-service" }
      ]
    }
    |
    v
ASTronaut Backend:
    1. installations tablosuna kaydet:
       { github_installation_id: 12345, owner: "my-org" }
    2. repos tablosuna kaydet:
       { installation_id: 1, repo_name: "payment-api",
         repo_full_name: "my-org/payment-api", is_active: "true" }
       { installation_id: 1, repo_name: "user-service",
         repo_full_name: "my-org/user-service", is_active: "true" }
    3. Log: info "New installation: my-org (2 repos)"
    |
    v
Kurulum tamamlandi. Artik deploy'lar dinleniyor.
```

---

## Faz 1: Gelistirici Deploy Yapiyor

```
Gelistirici → git push origin main
    |
    v
GitHub Actions: deploy.yml tetikleniyor
    |
    v
+----------------------------------------------+
|  .github/workflows/deploy.yml                |
|                                               |
|  name: Deploy                                 |
|  on: push: branches: [main]                  |
|                                               |
|  jobs:                                        |
|    build:                                     |
|      - run: npm run build                    |
|    test:                                      |
|      - run: npm test                         |
|    deploy:                                    |
|      - run: ./deploy.sh                      |
|                                               |
|  SONUC: Workflow completed, conclusion: success |
+----------------------------------------------+
    |
    v
GitHub otomatik olarak webhook gonderir
(cunku ASTronaut App "Workflow run" event'ine abone)
    |
    v
POST https://api.astronaut.com/webhook/github
Headers:
    x-github-event: workflow_run
    x-hub-signature-256: sha256=abc123...
    x-github-delivery: unique-delivery-id
Payload:
    {
      "action": "completed",
      "workflow_run": {
        "conclusion": "success",
        "head_sha": "a1b2c3d4e5f6",
        "head_branch": "main"
      },
      "repository": {
        "full_name": "my-org/payment-api",
        "default_branch": "main"
      },
      "installation": {
        "id": 12345
      }
    }
```

---

## Faz 2: Webhook Handler Isleme

```
POST /webhook/github istegi geldi
    |
    v
+--- ADIM 2.1: Signature Dogrulama ----------------+
|                                                    |
|  Gelen: x-hub-signature-256: sha256=abc123...      |
|                                                    |
|  Hesapla:                                          |
|    expected = HMAC-SHA256(WEBHOOK_SECRET, body)     |
|                                                    |
|  abc123... === expected ?                           |
|    +-- HAYIR → 401 Unauthorized don, DUR           |
|    +-- EVET → devam et                             |
+----------------------------------------------------+
    |
    v
+--- ADIM 2.2: Event Filtreleme --------------------+
|                                                    |
|  x-github-event === "workflow_run" ?               |
|    +-- HAYIR → 200 OK + "ignored" don, DUR        |
|    +-- EVET → devam et                             |
|                                                    |
|  payload.action === "completed" ?                  |
|    +-- HAYIR → 200 OK + "ignored" don, DUR        |
|    +-- EVET → devam et                             |
|                                                    |
|  payload.workflow_run.conclusion === "success" ?    |
|    +-- HAYIR → 200 OK + "deploy failed" don, DUR  |
|    +-- EVET → devam et                             |
+----------------------------------------------------+
    |
    v
+--- ADIM 2.3: Rate Limit Kontrolu -----------------+
|                                                    |
|  repoFullName = "my-org/payment-api"               |
|  Son 1 saatte bu repo icin kac analiz yapildi?     |
|                                                    |
|  count >= RATE_LIMIT_PER_HOUR (varsayilan: 10) ?   |
|    +-- EVET → 429 Too Many Requests don, DUR       |
|    +-- HAYIR → sayaci artir, devam et              |
+----------------------------------------------------+
    |
    v
+--- ADIM 2.4: DB'ye Webhook Event Kaydet ----------+
|                                                    |
|  webhook_events tablosuna ekle:                    |
|  {                                                 |
|    event_type: "workflow_run",                      |
|    action: "completed",                            |
|    repo_full_name: "my-org/payment-api",           |
|    payload: { ... tam webhook body ... },          |
|    processed: "pending"                            |
|  }                                                 |
+----------------------------------------------------+
    |
    v
+--- ADIM 2.5: Kuyruga Ekle (Debounce) -------------+
|                                                    |
|  Kuyrukta "my-org/payment-api" icin                |
|  bekleyen is var mi?                               |
|    +-- EVET → eski isi kuyruktan cikar,            |
|    |          yeni webhook'u ekle                   |
|    +-- HAYIR → yeni webhook'u kuyruga ekle          |
|                                                    |
|  Su an calisan analiz "my-org/payment-api" mi?     |
|    +-- EVET → bolme, bitmesini bekle.              |
|    |          Yeni is kuyrukta sirasini bekler      |
|    +-- HAYIR → devam et                            |
+----------------------------------------------------+
    |
    v
HTTP Response: 202 Accepted
{ "message": "Analysis queued", "repo": "my-org/payment-api" }

Arka planda kuyruk islemeye baslar...
```

---

## Faz 3: Kuyruk Isleme

```
Kuyruk durumu:
+----------------------------------------+
|  [1] my-org/payment-api   (a1b2c3d4)  |  <-- siradaki
|  [2] other-org/user-api   (x9y8z7w6)  |
|  [3] my-org/order-svc     (m3n4o5p6)  |
+----------------------------------------+

Aktif analiz sayisi: 1 / 3 (MAX_CONCURRENT_ANALYSES)
    |
    v
Slot musait → [1] numarali isi al
    |
    v
processAnalysis() basliyor...
Log: info "Analysis started" { owner: "my-org", repo: "payment-api", commitSha: "a1b2c3d4" }
```

---

## Faz 4: Yetki Kontrolu

```
+--- ADIM 4.1: Installation Token Al ---------------+
|                                                    |
|  DB'den installations tablosunu oku:               |
|    github_installation_id: 12345                   |
|    access_token: "ghs_xxx..."                      |
|    token_expires_at: 2026-04-02T14:30:00           |
|                                                    |
|  Su an: 2026-04-02T14:26:00                        |
|  token_expires_at - now = 4 dakika                 |
|  4 dk < 5 dk tampon → TOKEN YENILE                |
|                                                    |
|  1. JWT olustur:                                   |
|     { iss: GITHUB_APP_ID,                          |
|       iat: now,                                    |
|       exp: now + 10min }                           |
|     Sign with: GITHUB_APP_PRIVATE_KEY              |
|                                                    |
|  2. POST /app/installations/12345/access_tokens    |
|     Authorization: Bearer {jwt}                    |
|     → Response: { token: "ghs_yyy...",             |
|                   expires_at: "2026-04-02T15:26" } |
|                                                    |
|  3. DB guncelle:                                   |
|     access_token = "ghs_yyy..."                    |
|     token_expires_at = 2026-04-02T15:26:00         |
+----------------------------------------------------+
    |
    v
+--- ADIM 4.2: Repo Yetki Kontrolu -----------------+
|                                                    |
|  GET /repos/my-org/payment-api                     |
|  Authorization: token ghs_yyy...                   |
|                                                    |
|  Response:                                         |
|  {                                                 |
|    "archived": false,                              |
|    "permissions": {                                |
|      "push": true                                  |
|    }                                               |
|  }                                                 |
|                                                    |
|  archived === true ?                               |
|    +-- EVET → analiz iptal                         |
|    |   DB: status = "failed"                       |
|    |   error = "repo_archived"                     |
|    |   Log: warn "Repo is archived"                |
|    |   → CIKIS                                     |
|    +-- HAYIR → devam et                            |
|                                                    |
|  permissions.push === false ?                      |
|    +-- EVET → analiz iptal                         |
|    |   DB: status = "failed"                       |
|    |   error = "permission_denied"                 |
|    |   Log: warn "No push permission"              |
|    |   → CIKIS                                     |
|    +-- HAYIR → devam et                            |
+----------------------------------------------------+
```

---

## Faz 5: Repo Klonlama ve Guvenlik

```
+--- ADIM 5.1: Shallow Clone -----------------------+
|                                                    |
|  Timeout: 30 saniye (CLONE_TIMEOUT_MS)             |
|                                                    |
|  tempDir = /tmp/astronaut_my-org_payment-api_     |
|            1712063200000/                          |
|                                                    |
|  Komut:                                            |
|  git clone --depth 1 \                             |
|    https://x-access-token:ghs_yyy@github.com/ \    |
|    my-org/payment-api.git \                        |
|    {tempDir}                                       |
|                                                    |
|  Sonuc:                                            |
|    +-- TIMEOUT → hata logla, cleanup, CIKIS        |
|    +-- BASARILI → repoPath = tempDir, devam et     |
|                                                    |
|  Log: info "Repo cloned" { duration: 3200 }        |
+----------------------------------------------------+
    |
    v
+--- ADIM 5.2: Hassas Dosyalari Sil ----------------+
|                                                    |
|  Asagidaki dosyalari sil (varsa):                  |
|                                                    |
|    .env                                            |
|    .env.*          (.env.local, .env.production)   |
|    *.pem                                           |
|    *.key                                           |
|    *.pfx                                           |
|    *.p12                                           |
|    credentials.json                                |
|    service-account.json                            |
|    appsettings.Development.json                    |
|    appsettings.Local.json                          |
|                                                    |
|  DIKKAT: Wildcard isim eslestirme YAPMA!           |
|  *secret* → secretRoutes.ts'i de siler!            |
|  *credential* → credentialsController.cs'i siler!  |
|  Sadece bilinen dosya adi + uzanti pattern'leri.    |
|                                                    |
|  Log: info "Removed 2 sensitive files"              |
+----------------------------------------------------+
```

---

## Faz 6: Config Yukleme ve Framework Algilama

```
+--- ADIM 6.1: .autodoc.yml Kontrolu ---------------+
|                                                    |
|  {repoPath}/.autodoc.yml dosyasi var mi?           |
|                                                    |
|  +-- EVET → YAML parse et:                         |
|  |   Icerik:                                       |
|  |     framework: express                          |
|  |     docs_output: api/openapi.yaml               |
|  |                                                 |
|  |   config = {                                    |
|  |     framework: "express",                       |
|  |     docsOutput: "api/openapi.yaml"              |
|  |   }                                             |
|  |                                                 |
|  +-- HAYIR → config = null                         |
|      (varsayilanlar kullanilacak,                  |
|       otomatik algilama yapilacak)                 |
+----------------------------------------------------+
    |
    v
+--- ADIM 6.2: Framework Algilama ------------------+
|                                                    |
|  config.framework degeri var mi?                   |
|  +-- EVET → override, dogrudan kullan              |
|  +-- HAYIR → otomatik algila:                      |
|                                                    |
|  1. package.json var mi?                           |
|     +-- EVET → dependencies oku:                   |
|     |   {                                          |
|     |     "express": "^4.18.0"  ← BULUNDU         |
|     |   }                                          |
|     |   → Framework.EXPRESS                        |
|     |                                              |
|     |   Eger "@nestjs/core" olsaydi:               |
|     |   → Framework.NESTJS                         |
|     |                                              |
|     +-- HAYIR → .csproj ara                        |
|                                                    |
|  2. *.csproj dosyasi var mi?                       |
|     +-- EVET → icinde "Microsoft.AspNetCore" ?     |
|     |   +-- Controllers/ + [ApiController] var mi? |
|     |   |   → Framework.ASPNET_CONTROLLER          |
|     |   +-- MapGet/MapPost pattern var mi?          |
|     |   |   → Framework.ASPNET_MINIMAL             |
|     |   +-- Ikisi birden var mi?                   |
|     |       → Framework.ASPNET_BOTH                |
|     +-- HAYIR → HATA                               |
|         "Desteklenen framework bulunamadi"          |
|                                                    |
|  NOT: Bir repoda ya JS/TS ya da C# olacak.         |
|       Ikisi birden olmayacak.                      |
|                                                    |
|  Sonuc: framework = Framework.EXPRESS              |
|  Log: info "Detected framework: express"            |
+----------------------------------------------------+
```

---

## Faz 7: AST Parse (Framework'e Gore Dallanma)

### Senaryo A: Express Parser (Babel AST)

```
+--- ADIM 7A.1: Dosya Tarama -----------------------+
|                                                    |
|  Timeout: 60 saniye (PARSE_TIMEOUT_MS)             |
|                                                    |
|  Tum .ts ve .js dosyalarini bul                    |
|  HARIC:                                            |
|    x  node_modules/                                |
|    x  dist/                                        |
|    x  build/                                       |
|    x  test/                                        |
|    x  __tests__/                                   |
|    x  *.test.ts, *.test.js                         |
|    x  *.spec.ts, *.spec.js                         |
|                                                    |
|  Bulunan dosyalar:                                 |
|    src/app.ts                                      |
|    src/routes/userRoutes.ts                        |
|    src/routes/orderRoutes.ts                       |
|    src/middleware/auth.ts                           |
|    src/types/user.ts                               |
|    src/types/order.ts                              |
|                                                    |
|  Log: info "Found 6 source files"                   |
+----------------------------------------------------+
    |
    v
+--- ADIM 7A.2: Her Dosyayi Babel ile Parse Et -----+
|                                                    |
|  Ornek dosya - src/routes/userRoutes.ts:           |
|  +--------------------------------------------+   |
|  | import { Router } from 'express';           |   |
|  | import { authMiddleware } from '../mw';     |   |
|  | import { User } from '../types/user';       |   |
|  |                                             |   |
|  | const router = Router();                    |   |
|  |                                             |   |
|  | /** Get all users */                        |   |
|  | router.get('/users', (req, res) => {        |   |
|  |   // handler                                |   |
|  | });                                         |   |
|  |                                             |   |
|  | router.get('/users/:id',                    |   |
|  |   authMiddleware,                           |   |
|  |   (req: Request<{id: string}>, res) => {    |   |
|  |     // handler                              |   |
|  |   }                                         |   |
|  | );                                          |   |
|  |                                             |   |
|  | router.post('/users',                       |   |
|  |   authMiddleware,                           |   |
|  |   (req: Request<{}, {}, User>, res) => {    |   |
|  |     // handler                              |   |
|  |   }                                         |   |
|  | );                                          |   |
|  |                                             |   |
|  | export default router;                      |   |
|  +--------------------------------------------+   |
|                                                    |
|  Babel AST cikarimlari:                            |
|                                                    |
|  Route 1:                                          |
|    pattern: router.get('/users', handler)          |
|    path: "/users"                                  |
|    method: "GET"                                   |
|    middleware: []                                   |
|    auth: null                                      |
|    description: "Get all users" (JSDoc'tan)        |
|                                                    |
|  Route 2:                                          |
|    pattern: router.get('/users/:id',               |
|      authMiddleware, handler)                      |
|    path: "/users/:id"                              |
|    method: "GET"                                   |
|    middleware: ["authMiddleware"]                   |
|    auth: "Bearer" ← "auth" kelimesi geciyor        |
|    params: [                                       |
|      {name:"id", in:"path",                        |
|       type:"string", required:true}                |
|    ]                                               |
|                                                    |
|  Route 3:                                          |
|    pattern: router.post('/users',                  |
|      authMiddleware, handler)                      |
|    path: "/users"                                  |
|    method: "POST"                                  |
|    middleware: ["authMiddleware"]                   |
|    auth: "Bearer"                                  |
|    requestBody: { type: "User" }                   |
+----------------------------------------------------+
    |
    v
+--- ADIM 7A.3: Prefix Eslestirme ------------------+
|                                                    |
|  src/app.ts icinde:                                |
|  +--------------------------------------------+   |
|  | import userRouter from './routes/userRoutes';|  |
|  | import orderRouter from './routes/orderRoutes';||
|  |                                             |   |
|  | app.use('/api/v1', userRouter);             |   |
|  | app.use('/api/v1', orderRouter);            |   |
|  +--------------------------------------------+   |
|                                                    |
|  Import/export isim eslestirmesi:                  |
|    userRouter → src/routes/userRoutes.ts           |
|    orderRouter → src/routes/orderRoutes.ts         |
|                                                    |
|  Prefix uygula:                                    |
|    /users     → /api/v1/users                      |
|    /users/:id → /api/v1/users/:id                  |
+----------------------------------------------------+
    |
    v
+--- ADIM 7A.4: Tip Cozumleme ----------------------+
|                                                    |
|  src/types/user.ts:                                |
|  +--------------------------------------------+   |
|  | export interface User {                     |   |
|  |   id: number;                               |   |
|  |   email: string;                            |   |
|  |   name: string;                             |   |
|  |   age?: number;                             |   |
|  | }                                           |   |
|  +--------------------------------------------+   |
|                                                    |
|  Cikarilan PropertyInfo[]:                         |
|    {name:"id",    type:"number", required:true}    |
|    {name:"email", type:"string", required:true}    |
|    {name:"name",  type:"string", required:true}    |
|    {name:"age",   type:"number", required:false}   |
+----------------------------------------------------+
    |
    v
+--- ADIM 7A.5: Path Param Donusturme --------------+
|                                                    |
|  Express format → OpenAPI format:                  |
|    :id      → {id}                                 |
|    :orderId → {orderId}                            |
|                                                    |
|  /api/v1/users/:id → /api/v1/users/{id}           |
+----------------------------------------------------+
    |
    v
+--- ADIM 7A.6: Auth/Middleware Algilama ------------+
|                                                    |
|  Isim tabanli algilama:                            |
|  Middleware fonksiyon adinda su kelimeler           |
|  geciyorsa → auth alani doldurulur:                |
|    "auth", "guard", "protect", "verify",           |
|    "jwt", "passport", "token"                      |
|                                                    |
|  passport.authenticate() cagrisi → auth: "Bearer"  |
|                                                    |
|  Global middleware:                                |
|    app.use(authMiddleware) → TUM route'lara auth    |
|                                                    |
|  Router seviyesi:                                  |
|    router.use(verifyToken) → o router'in           |
|    route'larina auth                               |
|                                                    |
|  Inline fonksiyon → algilanamaz, auth = null       |
+----------------------------------------------------+
    |
    v
ParseResult ciktisi hazir (Express icin)
```

### Senaryo B: NestJS Parser (ts-morph) — Alternatif Akis

```
+--- NestJS Parser ---------------------------------+
|                                                    |
|  Timeout: 60 saniye                                |
|                                                    |
|  1. ts-morph Project olustur (tsconfig.json ile)   |
|                                                    |
|  2. Tum .ts dosyalarini tara                       |
|     (test/, __tests__/, *.test.ts, *.spec.ts haric)|
|                                                    |
|  Ornek dosya - src/users/users.controller.ts:      |
|  +--------------------------------------------+   |
|  | @Controller('users')                        |   |
|  | @UseGuards(AuthGuard)                       |   |
|  | export class UsersController {              |   |
|  |                                             |   |
|  |   /** Get user by ID */                     |   |
|  |   @Get(':id')                               |   |
|  |   findOne(@Param('id') id: string):         |   |
|  |     Promise<User> { }                       |   |
|  |                                             |   |
|  |   @Post()                                   |   |
|  |   create(@Body() dto: CreateUserDto):       |   |
|  |     Promise<User> { }                       |   |
|  | }                                           |   |
|  +--------------------------------------------+   |
|                                                    |
|  ts-morph analizi:                                 |
|                                                    |
|  3. @Controller('users') → prefix = "/users"       |
|  4. @UseGuards(AuthGuard) → class seviyesi auth    |
|     → tum method'lara uygulanir                    |
|  5. @Get(':id') → path="/users/{id}", method=GET   |
|  6. @Param('id') → param:{name:"id", in:"path"}   |
|  7. Promise<User> → response type cozumle          |
|  8. @Post() → path="/users", method=POST           |
|  9. @Body() dto: CreateUserDto → requestBody       |
|                                                    |
|  Tip cozumlemede circular dependency korumasi:      |
|  visited = Set<string>()                           |
|  User → orders: Order[] → user: User               |
|  "User" zaten visited'da → DONGUYU KES             |
|  Sadece tip ismini ver, property'leri ACMA          |
+----------------------------------------------------+
    |
    v
ParseResult ciktisi hazir (NestJS icin)
```

### Senaryo C: ASP.NET Parser (Roslyn via child_process) — Alternatif Akis

```
+--- ASP.NET Parser --------------------------------+
|                                                    |
|  Node.js tarafinda:                                |
|  child_process.execFile("dotnet", [                |
|    "/opt/astronaut/analyzer/bin/Release/           |
|     net8.0/ASTronautAnalyzer.dll",                   |
|    "/tmp/astronaut_my-org_..."                    |
|  ], { timeout: 120000 })                           |
|  Timeout: 120 saniye (restore 60s + parse 60s)     |
|                                                    |
|  .NET Analyzer icinde:                             |
|  +------------------------------------------------+|
|  | 1. *.csproj dosyasini bul                      ||
|  |                                                ||
|  | 2. dotnet restore calistir (max 60sn)          ||
|  |    +-- BASARILI → MSBuildWorkspace yukle        ||
|  |    |   (tam tip cozumleme, cross-file DTO)      ||
|  |    +-- BASARISIZ → fallback:                   ||
|  |        AdhocWorkspace + SyntaxTree              ||
|  |        (sadece syntax, tip cozumleme yok)       ||
|  |        errors[]: "NuGet restore failed —        ||
|  |                   type resolution limited"      ||
|  |                                                ||
|  | 3. Controller'lari parse et:                   ||
|  |    [ApiController]                             ||
|  |    [Route("api/[controller]")]                 ||
|  |    public class UsersController {              ||
|  |      [HttpGet("{id}")]                         ||
|  |      [Authorize]                               ||
|  |      public ActionResult<UserDto> Get(int id)  ||
|  |    }                                           ||
|  |    → route, params, auth, response type cikar  ||
|  |    → ActionResult<UserDto> → UserDto property'leri||
|  |    → Circular dep → HashSet<string> korumasi   ||
|  |    → XML comment varsa → description           ||
|  |                                                ||
|  | 4. Minimal API'lari parse et:                  ||
|  |    app.MapGet("/orders/{id}", (int id) => {})  ||
|  |    app.MapPost("/orders", (Order o) => {})     ||
|  |      .RequireAuthorization()                   ||
|  |    → route, params, requestBody, auth cikar    ||
|  |                                                ||
|  | 5. Sonuclari birlestir                         ||
|  | 6. JSON olarak stdout'a yaz                    ||
|  |    (System.Text.Json, camelCase)               ||
|  +------------------------------------------------+|
|                                                    |
|  Node.js:                                          |
|    stdout → JSON.parse → ParseResult               |
|    stderr varsa → errors dizisine ekle             |
+----------------------------------------------------+
    |
    v
ParseResult ciktisi hazir (ASP.NET icin)
```

---

## Faz 8: Ortak JSON Ciktisi (ParseResult)

```
Hangi parser calismis olursa olsun, cikti ayni formatta:

{
  "routes": [
    {
      "path": "/api/v1/users",
      "method": "GET",
      "controller": null,
      "routePrefix": "/api/v1",
      "params": [],
      "requestBody": null,
      "responses": [
        {
          "status": 200,
          "type": "User",
          "properties": [
            { "name": "id", "type": "number", "required": true },
            { "name": "email", "type": "string", "required": true },
            { "name": "name", "type": "string", "required": true },
            { "name": "age", "type": "number", "required": false }
          ]
        }
      ],
      "auth": null,
      "middleware": [],
      "description": "Get all users",
      "source": "src/routes/userRoutes.ts:7"
    },
    {
      "path": "/api/v1/users/{id}",
      "method": "GET",
      "controller": null,
      "routePrefix": "/api/v1",
      "params": [
        { "name": "id", "in": "path", "type": "string", "required": true }
      ],
      "requestBody": null,
      "responses": [
        {
          "status": 200,
          "type": "User",
          "properties": [...]
        }
      ],
      "auth": "Bearer",
      "middleware": ["authMiddleware"],
      "description": null,
      "source": "src/routes/userRoutes.ts:12"
    },
    {
      "path": "/api/v1/users",
      "method": "POST",
      "controller": null,
      "routePrefix": "/api/v1",
      "params": [],
      "requestBody": {
        "type": "User",
        "properties": [
          { "name": "email", "type": "string", "required": true },
          { "name": "name", "type": "string", "required": true },
          { "name": "age", "type": "number", "required": false }
        ]
      },
      "responses": [
        {
          "status": 200,
          "type": "User",
          "properties": [...]
        }
      ],
      "auth": "Bearer",
      "middleware": ["authMiddleware"],
      "description": null,
      "source": "src/routes/userRoutes.ts:20"
    }
  ],
  "errors": []
}

Log: info "Parsed 3 endpoints, 0 errors"
```

---

## Faz 9: Git Tag Alma

```
+--- GitHub API ile Tag Eslestirme ------------------+
|                                                    |
|  GET /repos/my-org/payment-api/tags                |
|  Authorization: token ghs_yyy...                   |
|                                                    |
|  Response:                                         |
|  [                                                 |
|    { "name": "v2.1.0",                             |
|      "commit": { "sha": "a1b2c3d4e5f6" } },       |  ← ESLEME!
|    { "name": "v2.0.0",                             |
|      "commit": { "sha": "z9y8x7w6" } }            |
|  ]                                                 |
|                                                    |
|  Webhook'taki commit SHA: "a1b2c3d4e5f6"           |
|  Tag listesinde bu SHA ile eslesen: "v2.1.0"       |
|                                                    |
|  → version = "2.1.0" ("v" prefix kaldirildi)       |
|                                                    |
|  Eslesen tag YOKSA:                                |
|  → version = "a1b2c3d" (SHA kisaltmasi)            |
+----------------------------------------------------+
```

---

## Faz 10: OpenAPI Spec Uretimi

```
+--- OpenAPI Generator -----------------------------+
|                                                    |
|  Girdi:                                            |
|    parseResult: { routes: [...], errors: [] }      |
|    options:                                        |
|      title: "payment-api" (repo adindan)           |
|      version: "2.1.0" (tag'den)                    |
|                                                    |
|  ADIM 1: Iskelet olustur                           |
|  {                                                 |
|    openapi: "3.0.3",                               |
|    info: {                                         |
|      title: "payment-api",                         |
|      version: "2.1.0"                              |
|    },                                              |
|    paths: {},                                      |
|    components: {                                   |
|      schemas: {},                                  |
|      securitySchemes: {}                           |
|    }                                               |
|  }                                                 |
|                                                    |
|  ADIM 2: Route'lari paths'e ekle                   |
|    Her route icin:                                 |
|      path → paths objesi                           |
|      method → get/post/put/delete                  |
|      params → parameters dizisi                    |
|      requestBody → $ref schema                     |
|      responses → status kodu bazli                 |
|      auth → security requirement                   |
|      description → summary                         |
|      controller → tags                             |
|                                                    |
|  ADIM 3: Schema isimlendirme                       |
|    Format: ControllerAdi.TipAdi                    |
|    Ornekler:                                       |
|      UsersController.User                          |
|      UsersController.CreateUserDto                 |
|      OrdersController.Order                        |
|    Controller null ise (Express):                  |
|      default.User                                  |
|      default.CreateUserDto                         |
|                                                    |
|  ADIM 4: Auth varsa securitySchemes ekle           |
|    "Bearer" → bearerAuth (http, bearer, JWT)       |
|    "ApiKey" → apiKeyAuth (apiKey, header)           |
|                                                    |
|  ADIM 5: Server bilgisi EKLENMEZ                   |
|    Kullanici nerede deploy ettigini biliyor        |
|                                                    |
|  ADIM 6: js-yaml ile YAML string'e donustur        |
+----------------------------------------------------+
    |
    v
Uretilen YAML:

openapi: "3.0.3"
info:
  title: payment-api
  version: "2.1.0"
paths:
  /api/v1/users:
    get:
      tags:
        - default
      description: Get all users
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/default.User'
    post:
      tags:
        - default
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/default.User'
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/default.User'
  /api/v1/users/{id}:
    get:
      tags:
        - default
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/default.User'
components:
  schemas:
    default.User:
      type: object
      required:
        - id
        - email
        - name
      properties:
        id:
          type: number
        email:
          type: string
        name:
          type: string
        age:
          type: number
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

Log: info "Generated OpenAPI spec (3 endpoints, 1 schema)"
```

---

## Faz 11: Token Yenileme + PR Acma

```
+--- ADIM 11.1: Token Gecerliligi Kontrol -----------+
|                                                    |
|  appAuth.getValidToken(12345)                      |
|  token_expires_at > now + 5dk ?                    |
|    +-- EVET → mevcut token'i kullan                |
|    +-- HAYIR → yeni token al, DB guncelle          |
+----------------------------------------------------+
    |
    v
+--- ADIM 11.2: Default Branch SHA Al --------------+
|                                                    |
|  Timeout: 15 saniye (PR_TIMEOUT_MS)                |
|                                                    |
|  GET /repos/my-org/payment-api/git/ref/heads/main  |
|  Authorization: token ghs_yyy...                   |
|                                                    |
|  → sha: "f5e4d3c2b1a0"                            |
+----------------------------------------------------+
    |
    v
+--- ADIM 11.3: Branch Olustur ---------------------+
|                                                    |
|  POST /repos/my-org/payment-api/git/refs           |
|  {                                                 |
|    "ref": "refs/heads/astronaut/                  |
|            docs-2026-04-02-143500",                |
|    "sha": "f5e4d3c2b1a0"                          |
|  }                                                 |
+----------------------------------------------------+
    |
    v
+--- ADIM 11.4: Dosya Commit Et --------------------+
|                                                    |
|  Dosya zaten var mi kontrol et:                    |
|  GET /repos/my-org/payment-api/contents/           |
|    docs/openapi.yaml                               |
|    ?ref=astronaut/docs-2026-04-02-143500          |
|  +-- 200 → onceki SHA'yi al (guncelleme)           |
|  +-- 404 → yeni dosya (olusturma)                  |
|                                                    |
|  PUT /repos/my-org/payment-api/contents/           |
|    docs/openapi.yaml                               |
|  {                                                 |
|    "message": "docs: update API documentation      |
|                (ASTronaut)",                       |
|    "content": "b3BlbmFwaTog...",  ← Base64 spec    |
|    "branch": "astronaut/docs-2026-04-02-143500",  |
|    "sha": "..." (guncelleme ise)                   |
|  }                                                 |
|                                                    |
|  NOT: docsOutput config'de farkli bir yol          |
|  belirtilmisse o yol kullanilir.                   |
|  Ornek: .autodoc.yml'de docs_output: api/spec.yaml |
|  → api/spec.yaml'a yazilir                         |
+----------------------------------------------------+
    |
    v
+--- ADIM 11.5: PR Ac ------------------------------+
|                                                    |
|  POST /repos/my-org/payment-api/pulls              |
|  {                                                 |
|    "title": "docs: API documentation update        |
|              — 2.1.0",                             |
|    "head": "astronaut/docs-2026-04-02-143500",    |
|    "base": "main",                                 |
|    "body": (asagidaki PR description)              |
|  }                                                 |
|                                                    |
|  PR Description:                                   |
|  +--------------------------------------------+   |
|  | ## API Documentation Generated              |   |
|  |                                             |   |
|  | **Version:** 2.1.0                          |   |
|  | **Endpoints found:** 3                      |   |
|  |                                             |   |
|  | | Method | Path               |            |   |
|  | |--------|--------------------|            |   |
|  | | GET    | /api/v1/users      |            |   |
|  | | GET    | /api/v1/users/{id} |            |   |
|  | | POST   | /api/v1/users      |            |   |
|  |                                             |   |
|  | ---                                         |   |
|  | > Your source code has been deleted from    |   |
|  |   our servers immediately after analysis.   |   |
|  +--------------------------------------------+   |
|                                                    |
|  Response:                                         |
|  {                                                 |
|    "number": 42,                                   |
|    "html_url": "https://github.com/my-org/         |
|                 payment-api/pull/42"               |
|  }                                                 |
|                                                    |
|  Log: info "PR created: #42"                        |
+----------------------------------------------------+
```

---

## Faz 12: Cleanup ve Kayit

```
+--- ADIM 12.1: Repo Sil ---------------------------+
|                                                    |
|  rm -rf /tmp/astronaut_my-org_payment-api_...     |
|                                                    |
|  Log: info "Repo cleaned up"                        |
+----------------------------------------------------+
    |
    v
+--- ADIM 12.2: DB'ye Analiz Sonucu Kaydet ---------+
|                                                    |
|  analyses tablosuna ekle:                          |
|  {                                                 |
|    repo_id: 1,                                     |
|    commit_sha: "a1b2c3d4e5f6",                     |
|    tag: "v2.1.0",                                  |
|    spec: "openapi: 3.0.3\ninfo:\n  title:...",    |
|    status: "success",                              |
|    errors: null,                                   |
|    endpoint_count: 3,                              |
|    pr_number: 42,                                  |
|    pr_url: "https://github.com/my-org/             |
|             payment-api/pull/42",                  |
|    duration_ms: 8450                               |
|  }                                                 |
+----------------------------------------------------+
    |
    v
+--- ADIM 12.3: Webhook Event Guncelle -------------+
|                                                    |
|  webhook_events tablosunu guncelle:                |
|    processed: "done"                               |
|    processed_at: 2026-04-02T14:35:08               |
+----------------------------------------------------+
    |
    v
Log: info "Analysis complete" {
  owner: "my-org",
  repo: "payment-api",
  endpoints: 3,
  pr: 42,
  duration: 8450
}
    |
    v
Kuyruktan sonraki ise gec...
```

---

## Faz 13: Kullanici Deneyimi

```
Gelistirici GitHub'da PR bildirimini gorur:

+------------------------------------------------------+
|  ASTronaut opened a pull request                     |
|                                                       |
|  docs: API documentation update — 2.1.0         #42  |
|  astronaut/docs-2026-04-02-143500 → main             |
|                                                       |
|  ## API Documentation Generated                       |
|                                                       |
|  **Version:** 2.1.0                                   |
|  **Endpoints found:** 3                               |
|                                                       |
|  | Method | Path               |                      |
|  |--------|--------------------|                      |
|  | GET    | /api/v1/users      |                      |
|  | GET    | /api/v1/users/{id} |                      |
|  | POST   | /api/v1/users      |                      |
|                                                       |
|  ---                                                  |
|  > Your source code has been deleted from our         |
|    servers immediately after analysis.                 |
|                                                       |
|  Files changed (1):                                   |
|    docs/openapi.yaml  +85 lines                       |
|                                                       |
|  [Review changes]  [Merge pull request]  [Close]      |
+------------------------------------------------------+

Gelistirici:
  1. PR'i review eder → spec'e bakar
  2. "Merge pull request" tiklar
  3. docs/openapi.yaml repo'da kalir
  4. Bir sonraki deploy'da ASTronaut tekrar calisir,
     guncel spec ile yeni PR acar
```

---

## Hata Senaryolari

### Senaryo H1: Kismi Basari (Partial)

```
+--- Kismi Basari ----------------------------------+
|                                                    |
|  5 dosyadan 4'u parse edildi, 1'i hata verdi       |
|                                                    |
|  errors: [                                         |
|    { "file": "src/routes/legacy.js",               |
|      "reason": "dynamic route pattern              |
|                 not supported" }                   |
|  ]                                                 |
|                                                    |
|  Aksiyon: PR AC, description'da uyari ekle         |
|                                                    |
|  PR Description'a eklenen:                         |
|  ### Parse Warnings                                |
|  - src/routes/legacy.js — dynamic route pattern    |
|    not supported                                   |
|                                                    |
|  DB: status = "partial"                            |
|  DB: errors = [{...}]                              |
+----------------------------------------------------+
```

### Senaryo H2: Tamamen Basarisiz (Failed)

```
+--- Tamamen Basarisiz -----------------------------+
|                                                    |
|  Hicbir endpoint bulunamadi                        |
|  VEYA kritik parse hatasi                          |
|  VEYA framework algilanamadi                       |
|                                                    |
|  Aksiyon: PR ACMA                                  |
|                                                    |
|  DB: status = "failed"                             |
|  DB: errors = [{ reason: "..." }]                  |
|  Log: error "Analysis failed" { ... }              |
+----------------------------------------------------+
```

### Senaryo H3: Yetki Hatasi

```
+--- Yetki Hatasi ----------------------------------+
|                                                    |
|  Repo archived veya push yetkisi yok               |
|                                                    |
|  Aksiyon: Analizi BASLATMA                         |
|           (clone bile yapma, kaynak harcama)        |
|                                                    |
|  DB: status = "failed"                             |
|  DB: errors = [{ reason: "permission_denied" }]    |
|  VEYA                                              |
|  DB: errors = [{ reason: "repo_archived" }]        |
+----------------------------------------------------+
```

### Senaryo H4: Timeout

```
+--- Timeout Hatalari ------------------------------+
|                                                    |
|  Her adim kendi timeout'u ile calisir:             |
|                                                    |
|  Clone > 30sn (CLONE_TIMEOUT_MS)                   |
|    → HATA: "Clone timeout"                         |
|    → Cleanup + DB kayit                            |
|                                                    |
|  Restore > 60sn (RESTORE_TIMEOUT_MS)               |
|    → fallback: syntax-only parse                   |
|    → errors[]: "NuGet restore timeout"             |
|                                                    |
|  Parse > 60sn (PARSE_TIMEOUT_MS)                   |
|    → HATA: "Parse timeout"                         |
|    → Cleanup + DB kayit                            |
|                                                    |
|  PR acma > 15sn (PR_TIMEOUT_MS)                    |
|    → HATA: "GitHub API timeout"                    |
|    → Spec uretildi ama PR acilamadi                |
|    → DB: status = "failed",                        |
|      errors = [{ reason: "pr_timeout" }]           |
|                                                    |
|  Hangi adimda tikandigini loglar:                  |
|  Log: error "Timeout at step: clone" { ... }       |
+----------------------------------------------------+
```

### Senaryo H5: Rate Limit

```
+--- Rate Limit ------------------------------------+
|                                                    |
|  Ayni repo son 1 saatte 10 kez analiz istedi       |
|                                                    |
|  Aksiyon: 429 Too Many Requests don                |
|           Analiz baslatma                          |
|                                                    |
|  DB: webhook_events tablosuna kaydet               |
|      processed: "skipped"                          |
|      error_message: "rate_limit_exceeded"          |
+----------------------------------------------------+
```

### Senaryo H6: dotnet restore Basarisiz

```
+--- dotnet restore Basarisiz ----------------------+
|                                                    |
|  Private NuGet feed veya network hatasi            |
|                                                    |
|  Aksiyon: Fallback — AdhocWorkspace kullan         |
|           (tip cozumleme YOK, sadece syntax parse) |
|                                                    |
|  Route'lar ve attribute'ler bulunur                |
|  AMA response/request tip property'leri cikarilmaz |
|                                                    |
|  PR acilir, description'da uyari:                  |
|  ### Parse Warnings                                |
|  - NuGet restore failed — type resolution limited  |
|                                                    |
|  DB: status = "partial"                            |
+----------------------------------------------------+
```

### Senaryo H7: Debounce — Hizli Art Arda Deploy

```
+--- Debounce Senaryosu ----------------------------+
|                                                    |
|  14:30:00 — Webhook #1 geldi (commit: aaa111)      |
|             Kuyruga eklendi                         |
|  14:30:05 — Webhook #2 geldi (commit: bbb222)      |
|             Kuyrukta #1 bekliyor → #1'i cikar       |
|             #2'yi kuyruga ekle                      |
|  14:30:10 — Kuyruk islemeye baslar                  |
|             Sadece #2 (bbb222) analiz edilir        |
|             #1 (aaa111) atildi                      |
|                                                    |
|  Farkli senaryo — #1 zaten calisiyor:              |
|  14:30:00 — Webhook #1 geldi → analiz BASLADI      |
|  14:30:05 — Webhook #2 geldi                       |
|             #1 calisiyor → bolme, bitmesini bekle   |
|             #2 kuyruga eklendi                      |
|  14:30:15 — #1 bitti                               |
|  14:30:16 — #2 baslar                              |
|             Sonuc: 2 PR acilir (farkli commit'ler)  |
+----------------------------------------------------+
```

---

## Ozet: Tam Akis (Tek Satirda)

```
Deploy basarili
  → GitHub webhook
  → Signature dogrula
  → Event filtrele
  → Rate limit kontrol
  → Kuyruga ekle (debounce)
  → Yetki kontrol (push + archived)
  → Clone (--depth 1)
  → Hassas dosyalari sil
  → .autodoc.yml oku (opsiyonel)
  → Framework algila
  → AST parse (Express/NestJS/ASP.NET)
  → Ortak JSON format
  → Git tag al (GitHub API)
  → OpenAPI 3.0.3 spec uret (YAML)
  → Token yenile (gerekirse)
  → Branch olustur
  → Dosya commit et
  → PR ac
  → Repo sil
  → DB'ye kaydet
  → Kuyruktan sonraki ise gec
```
