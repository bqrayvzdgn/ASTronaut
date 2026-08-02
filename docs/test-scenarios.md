# ASTronaut — Canlı Test Senaryoları

> Amaç: ASTronaut'un (ASP.NET Core kaynak → OpenAPI 3.1) gerçek projeler üzerinde
> **canlı** olarak test edileceği senaryoların tam envanteri. Bu doküman bir QA
> test planıdır; her senaryo bir girdi (C# yapısı veya CLI çağrısı) ve beklenen
> çıktı davranışıyla tanımlanır.
>
> **Kapsamlı kod-doğrulaması (2026-08-01):** Bütün katalog, "gerçek bir API projesi
> neler içerebilir?" ekseninde 7 paralel ajanla kod tabanına karşı yeniden tarandı.
> Aşağıdaki **Durum** işaretleri artık varsayım değil, `analyzers/dotnet/src` koddan
> doğrulanmıştır. Boşlukların önceliklendirilmiş listesi için bölüm sonundaki
> **"Kaynak-doğrulanmış boşluk sıralaması"na** bakın.

## Pipeline & test yüzeyi

```
C# kaynak ──▶ .NET analyzer (Roslyn) ──▶ ParseResult (IR, JSON) ──▶ generator ──▶ OpenAPI 3.1 (YAML/JSON)
```

Canlı testin dokunduğu her katman:

| Katman | Ne test edilir |
| --- | --- |
| **Keşif** (`detect.ts`) | dizin / `.csproj` / `.sln` / `.slnx` doğru çözümleniyor mu |
| **Analyzer** (Roslyn) | C# yapıları → IR doğru mu, çökme/diagnostic davranışı |
| **parser-bridge** | subprocess spawn, non-zero exit, bozuk JSON, IR zod doğrulaması |
| **generator** | IR → geçerli OpenAPI 3.1, dedup, `$ref`, securitySchemes |
| **CLI** | opsiyonlar, çıkış kodları, dosya/stdout yazımı |

## Test seviyeleri

1. **Unit** (`dotnet test analyzers/dotnet/Tests`) — in-memory Roslyn, MSBuild yok.
2. **E2E fixture** (`pnpm test:e2e`) — checked-in fixture'lar: gerçek C# → analyzer → IR → OpenAPI → 3.1 meta-şema doğrulaması + operationId/param benzersizlik invariant'ları.
3. **Canlı** (bu doküman) — **gerçek, dışarıdan** ASP.NET Core projeleri üzerinde uçtan uca `analyze` çalıştırma.

## Nasıl çalıştırılır (canlı)

```bash
node apps/cli/dist/bin.js analyze <gerçek-proje-yolu> -o out.yaml
```

Doğrulama için beklenen: sıfır çıkış kodu, geçerli OpenAPI 3.1, ve manuel gözden geçirme.

## Durum işaretleri

- ✅ **Kapsanıyor** — koddan doğrulanmış doğru davranış (çoğu için fixture/unit test de var).
- ⚠️ **Kısmi** — destekleniyor ama eksik/yanlış nüans var; canlıda doğrula.
- ❓ **Doğrula** — davranış belirsiz / izole test yok; canlı testin asıl hedefi.
- ✗ **Boşluk** — ASP.NET Core'da yaygın ama desteklenmiyor; regresyon/known-gap adayı.

> Not: ⚠️/❓/✗ satırları canlı testin **öncelikli** hedefleridir. ✗ satırları
> "analyzer düşmeden, sessizce yanlış üretmeden, tercihen bir W-diagnostic ile"
> ele almalı — canlı testte asıl kontrol budur.

---

## A. Proje keşfi & girdi tipleri (CLI/IO)

| ID | Senaryo | Girdi | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| A1 | Dizin içinde tek `.csproj` | `analyze ./app` | csproj bulunur, `project` kind | ✅ |
| A2 | Doğrudan `.csproj` yolu | `analyze ./app/App.csproj` | doğrudan kullanılır | ✅ |
| A3 | Dizin içinde `.sln` | `analyze ./repo` | solution seçilir (csproj'a öncelikli) | ✅ |
| A4 | Doğrudan `.slnx` yolu | `analyze ./repo/App.slnx` | solution kind | ✅ |
| A5 | Solution + csproj birlikte | dizinde hem `.sln` hem `.csproj` | `.sln` kazanır (öncelik) | ✅ |
| A6 | İç içe / derin dizinde csproj | `analyze ./repo` (csproj alt klasörde) | DFS bulur | ✅ |
| A6b | Dizinde **birden çok** csproj/sln | | **deterministik**: Ordinal-first seçim + W007 uyarısı (non-determinizm giderildi) | ✅ |
| A7 | `bin`/`obj`/`node_modules` atlanır | build artefaktı olan dizin | bu klasörler atlanır | ✅ |
| A8 | Var olmayan yol | `analyze ./yok` | "No supported project", exit 1 | ✅ |
| A9 | Analyzable olmayan dizin | boş klasör / sadece `.txt` | exit 1 | ✅ |
| A10 | Sadece `bin`/`obj` içeren dizin | derlenmiş ama kaynak yok | csproj bulunamaz → E001, exit 1 (0 route değil) | ✅ |
| A11 | Çok büyük monorepo | binlerce dosya | ilk csproj/sln, makul süre (I/O sınırı yok — S5) | ❓ |
| A12 | Boşluk/Unicode içeren yol | `analyze "C:\Proje Ç"` | doğru çalışır | ❓ |
| A13 | Göreli vs mutlak yol | `./app` vs `C:\...\app` | `resolve` ile aynı sonuç | ⚠️ |
| A14 | **detect.ts ↔ ProjectLoader çift çözümleme** | dizin girdisi | CLI `detect.ts`'i yalnız title/mesaj için kullanır; analyzer'a ham dizin gider, ProjectLoader bağımsız yeniden çözer. Karşılaştırıcılar farklı (`localeCompare` vs `Ordinal`) → çoklu-aday edge-case'te title yanlış projeden gelebilir | ⚠️ |
| A15 | `Directory.Build.props` / central package mgmt | MSBuild import | MSBuild derlemeyi normal yükler (props/CPM şeffaf); analyzer özel işlem yapmaz | ❓ |
| A16 | Derlenmeyen / restore edilmemiş proje | eksik paket | `WorkspaceFailed` → W003; kısmi derleme ile devam, compilation null ise E001 | ⚠️ |
| A17 | TFM çeşitliliği (net6/7/8/9) | | Roslyn TFM-agnostik; net8 test edilmiş, diğerleri izole test yok | ❓ |

## B. Routing — Controllers

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| B1 | `[ApiController]` + `[Route]` + `[HttpGet]` | UsersController | route emit edilir | ✅ |
| B2 | Tüm HTTP verb'leri | Get/Post/Put/Delete/Patch | her biri ayrı operation | ✅ |
| B3 | `[HttpHead]` / `[HttpOptions]` | | verb map'te var → emit | ✅ |
| B4 | `[Route("[controller]")]` token | `api/v1/[controller]` | controller adı ile değişir (PascalCase) | ✅ |
| B5 | `[controller]` + `[action]` token | `[controller]/[action]` | ikisi de değiştirilir | ✅ |
| B6 | Sınıf + method route birleşimi + slash normalizasyonu | `[Route("api/")]`+`[HttpGet("/x")]` | tek `/` ile birleşir | ✅ |
| B7 | Method üzerinde birden çok Http attribute | `[HttpGet("a")][HttpPost("b")]` | her biri ayrı route | ✅ |
| B8 | `[Route]` verb attribute olmadan (action) | sadece `[Route("x")]` method | ASP.NET tüm verbler için reach eder; analyzer **sessizce route üretmez** | ✗ |
| B9 | Absolute path override (`/health`) | `[HttpGet("/health")]` | controller route yoksayılır | ✅ |
| B10 | `[ApiController]` olmayan controller | plain `Controller` | emit edilir mi? | ❓ |
| B11 | `ControllerBase` yerine `Controller` (MVC View) | | API mı sayılır? | ❓ |
| B12 | Abstract/base controller'dan miras action | base sınıfta `[HttpGet]` | **çalışıyor:** `CollectActionMethods` kalıtım zincirini yürür (imza-bazlı dedup) → base action'lar dahil | ✅ |
| B13 | Generic controller | `Ctrl<T>` | non-abstract açık generic controller **atlanır** + **W004**; concrete `X : Base<T>` etkilenmez | ✅ |
| B14 | `[ApiVersion]` / versiyonlu route (URL-segment) | `[ApiVersion("1.0")]`+`{version:apiVersion}` | somut `/api/v1.0/...`; çoklu `[ApiVersion]` → versiyon başına ayrı route | ✅ |
| B15 | `[NonAction]` / `[ApiExplorerSettings(IgnoreApi)]` | | method+controller düzeyinde dışlanır → route üretilmez | ✅ |
| B16 | Private/protected action | | route üretilmemeli | ❓ |
| B17 | `[AcceptVerbs("GET","POST")]` çoklu verb | | her verb için ayrı route (case-insensitive, opsiyonel `Route=`) | ✅ |
| B18 | Method düzeyinde **birden çok `[Route]`** (verb'siz) | `[Route("a")][Route("b")]` | ASP.NET her ikisini reach eder → 2 route; analyzer yalnız Http\*/AcceptVerbs okur → **route yok** | ✗ |
| B19 | Class düzeyinde **birden çok `[Route]`** | `[Route("api")][Route("v2/api")]` | her prefix için route; analyzer **yalnız ilkini** okur | ✗ |
| B20 | Conventional routing `MapControllerRoute` | `endpoints.MapControllerRoute(...)` | attribute'suz controller/action route alır; analyzer **hiç emit etmez** | ✗ |
| B21 | Area token `[area]` / `[Area("Admin")]` | `[Route("[area]/[controller]")]` | area segmente girer; `[area]` token'ı **literal kalır** | ✗ |
| B22 | `~/` absolute override | `[HttpGet("~/health")]` | prefix atlanmalı; **yanlış birleştirilir** (`prefix/~/health`) | ✗ |
| B23 | `[HttpTrace]` / `[HttpConnect]` | | verb map'te yok → emit edilmez, uyarı yok | ✗ |
| B24 | `[AcceptVerbs]` bilinmeyen/özel verb | `[AcceptVerbs("LINK")]` | ctor arg'ı ham upper-case verb olur (doğrulama yok) | ⚠️ |
| B25 | Attribute shorthand vs full (`[HttpGetAttribute]`) | | ikisi de tanınır | ✅ |
| B26 | `[Obsolete]` controller/action → deprecated | | route `deprecated: true` | ✅ |
| B27 | Boş method+class route | `[HttpGet]` tek başına | path `/` (root), çökme yok | ✅ |
| B28 | Query-string versiyonlama | `?api-version=1.0` | version query param; **hiç modellenmez** | ✗ |
| B29 | Header versiyonlama | `X-Api-Version: 1.0` | version header param; **hiç modellenmez** | ✗ |
| B30 | Media-type versiyonlama | `Accept: ...;v=1.0` | content-type varyantı; **hiç modellenmez** | ✗ |
| B31 | `[ApiVersionNeutral]` | | tüm versiyonlarda tek route; attribute okunmaz ama versiyonsuz zaten tek route → tesadüfen doğru | ⚠️ |
| B32 | `[MapToApiVersion("2.0")]` action | | action'ı o versiyona kısıtlamalı; **yok sayılır → controller'ın TÜM versiyonlarına fan-out (yanlış route uydurur)** | ✗ |
| B33 | Deprecated versiyon `[ApiVersion("1.0",Deprecated=true)]` | | o versiyon `deprecated:true`; named arg okunmaz | ✗ |
| B34 | Action düzeyinde `[ApiVersion]` (controller değil) | | yalnız controller'dan okunur → yok sayılır | ✗ |

## C. Routing — Minimal API  *(kaldırıldı)*

> ⛔ **Minimal API desteği kaldırıldı** (`feat/remove-minimal-api`). ASTronaut yalnızca
> Controller tabanlı ASP.NET Core projelerini analiz eder. Buradaki C1–C17 senaryoları
> ve minimal'e özgü tüm satırlar (E10–E11, G11–G14/G17, M4–M5/M11) geçersizdir. Bölüm
> harfi, sonraki bölümlere yapılan atıflar bozulmasın diye korunmuştur. Minimal API
> ileride genericity yol haritası kapsamında yeniden değerlendirilebilir.

## D. Route template & constraint'ler

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| D1 | Basit param | `{id}` | path param, string | ✅ |
| D2 | `int` constraint | `{id:int}` | integer | ✅ |
| D3 | `int:min(1)` kombine | `{id:int:min(1)}` | integer + minimum | ✅ |
| D4 | `guid` | `{uuid:guid}` | string, format uuid | ✅ |
| D5 | `alpha` / `alpha:length(3,40)` | slug | string (+ min/maxLength) | ✅ |
| D6 | `long` | `{id:long}` | integer int64 | ✅ |
| D7 | `bool` / `datetime` / `decimal` / `double` / `float` | | doğru primitive+format | ✅ |
| D8 | `max(n)` / `range(a,b)` / `minlength` / `maxlength` / `length` | | constraint'e map | ✅ |
| D9 | `regex(...)` (içinde `:` olsa bile) | `{c:regex(^\d+:\d+$)}` | pattern korunur (parantez-duyarlı split) | ✅ |
| D10 | Opsiyonel param `{id?}` | | `?` strip edilir; path olduğu için `Required=true` kalır — opsiyonellik yansımaz | ⚠️ |
| D11 | Default değerli `{id=5}` | | `=5` strip; **default emit edilmez** | ⚠️ |
| D12 | Catch-all `{*rest}` / `{**rest}` | | `*`/`**` strip → normal param; catch-all (`/`-kabul) semantiği modellenmez | ⚠️ |
| D13 | Tek segmentte çok param | `{y}-{m}-{d}` | hepsi ayrı path param | ✅ |
| D14 | Custom/bilinmeyen constraint | `{id:mycustom}` | string fallback, çökme yok | ✅ |
| D15 | Query string route template'de yok | | path only | ✅ |
| D16 | `required` route constraint | `{id:required}` | switch'te yok → string fallback (no-op) | ⚠️ |
| D17 | Route-template constraint + C# param tipi birleşimi | `{id:int}` + `long id` | C# tipi tercih, template constraint korunur | ✅ |
| D18 | Trailing-slash normalizasyonu | `"api/x/"` | sondaki `/` trim | ✅ |

## E. Parametreler & binding

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| E1 | `[FromRoute]` | | path param | ✅ |
| E2 | `[FromQuery]` | | query param | ✅ |
| E3 | `[FromHeader]` / `[FromQuery]` / `[FromRoute]` **`Name="..."` override** | `[FromHeader(Name="X-Trace-Id")]` | param adı = attribute `Name`; **kod her zaman C# adını (`p.Name`) kullanır → override yok sayılır** | ✗ |
| E4 | `[FromBody]` | | request body | ✅ |
| E5 | `[FromForm]` / `IFormFile` | | multipart/form-data + binary | ⚠️ |
| E6 | Attribute'suz basit param → query | `int page = 1` | query param | ✅ |
| E6b | Attribute'suz **string** param → query | `string term` | query param (service sanılıp düşmez) | ✅ |
| E7 | Attribute'suz complex tip → body | `CreateDto dto` | body | ✅ |
| E8 | Nullable param `string? q` | | required=false | ✅ |
| E9 | Default değerli param `int size = 20` | | required=false | ✅ |
| E11b | **Concrete class** service (`AppDbContext`) | ctor DI, attribute yok | EF Core `DbContext` base-type tespiti → service, body'ye bağlanmaz | ✅ |
| E12 | `[AsParameters]` struct/class binding | `[AsParameters] Query q` | her alan ayrı query param; **switch'te yok → tüm struct body'ye bağlanır (yanlış)** | ✗ |
| E13 | `[FromKeyedServices]` | | atlanır | ✅ |
| E14 | Array/list query `[FromQuery] int[] ids` | | array query param | ✅ |
| E15 | Enum query param | `[FromQuery] Status s` | `IsSimpleType` enum'ı simple sayar (Nullable dahil) → query | ✅ |
| E16 | Aynı isimli path+query çakışması | | duplicate param invariant korunur | ✅ |
| E17 | `[BindRequired]` / `[BindNever]` | | required / atla; **kodda hiç okunmuyor** (BindNever param yine emit, BindRequired etkisiz) | ✗ |
| E18 | Complex `[FromQuery]` flatten | `[FromQuery] Filter f` | properties → query param'lara flatten | ✅ |
| E19 | `[FromForm]` **scalar** | `[FromForm] string title` | form field olmalı; FromForm binding case yok → `string` **query**'ye düşer | ✗ |
| E20 | **Implicit** collection (attribute'suz) | `List<int> ids` | query olmalı; `IsEnumerable`+`IsSimpleType` false → **body**'ye düşer | ⚠️ |
| E21 | Nested complex `[FromQuery]` | `Filter{ Sort Nested }` | yalnız 1 seviye flatten; nested tek param'da OBJECT kalır | ⚠️ |
| E22 | `[FromServices]` (keyed olmayan) | | atlanır | ✅ |

## F. Request body

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| F1 | `[FromBody] Dto` | | application/json body, schema $ref | ✅ |
| F2 | Body required/optional | `[FromBody] Dto?` | nullable → required=false | ✅ |
| F3 | Body olarak List/array | `[FromBody] List<T>` | array schema | ✅ |
| F4 | Body olarak primitive | `[FromBody] string` | string body | ✅ |
| F5 | `IFormFile` tek dosya | | binary format + multipart | ✅ |
| F6 | `IFormFileCollection` / `List<IFormFile>` | | array binary | ✅ |
| F7 | `[Consumes("application/xml")]` | | content_type override (şema yine JSON-türevli obj) | ⚠️ |
| F8 | Çoklu `[Consumes]` | | content_types listesi | ✅ |
| F9 | GET + body (anti-pattern) | | verb kontrolü yok, body yine emit | ⚠️ |
| F10 | `[FromForm]` **complex** flatten | `[FromForm] UploadDto` | form field'lara flatten olmalı; tek OBJECT multipart olarak emit | ⚠️ |
| F11 | `Stream` / `byte[]` / octet-stream body | `[FromBody] Stream` | binary/octet-stream olmalı; `byte[]`→json base64, `Stream`→karışık OBJECT | ✗ |
| F12 | `ProblemDetails` input body | `[FromBody] ProblemDetails` | object $ref | ✅ |
| F13 | `[Consumes]` **body param yokken** | | content_type kaybolur (body==null → Consumes uygulanmaz) | ⚠️ |

## G. Response & status kodları

Öncelik zinciri (kritik): `[ProducesResponseType*]` varsa **yalnız** onlar okunur (gövde/dönüş tipi yok sayılır) → yoksa `ControllerResultReader` (gövde `return`'leri) → yoksa dönüş tipinden çıkarım.

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| G1 | `ActionResult<T>` dönüş | | 200 + T şeması | ✅ |
| G2 | `IActionResult` (tipsiz) | | verb'e göre default status, gövdesiz | ✅ |
| G3 | `[ProducesResponseType(typeof(T),200)]` | | 200 + T | ✅ |
| G4 | `[ProducesResponseType(404)]` (gövdesiz) | | 404 açıklama | ✅ |
| G5 | `[ProducesResponseType<T>(201)]` generic | | 201 + T | ✅ |
| G6 | Çoklu ProducesResponseType | 200+400+404 | her biri response (bu yolda dedup yok) | ✅ |
| G7 | `Task<ActionResult<T>>` / async | | Task→ActionResult→T unwrap (≤4 seviye) | ✅ |
| G8 | `ValueTask<T>` | | unwrap | ✅ |
| G9 | `Ok(obj)` / `NotFound()` gövde çıkarımı | | 200+arg şeması / 404 gövdesiz | ✅ |
| G10 | `CreatedAtAction` / `BadRequest(x)` | | 201 (gövde=son arg) / 400 (arg0) | ✅ |
| G16 | `void` / `Task` dönüş | | verb'e göre default status, gövdesiz (bkz. G22) | ⚠️ |
| G18 | `File(...)` / `PhysicalFile` / `FileStream` | | 200 + binary + `application/octet-stream` | ✅ |
| G19 | `Redirect` / 3xx | | Redirect→302, *Permanent→301, gövdesiz | ✅ |
| G20 | Birden çok return farklı tip | `if...return A else B` | aynı status'ta dedup, şema taşıyan kazanır → **oneOf yok** | ⚠️ |
| G21 | 204 NoContent (Delete) | `NoContent()` / DELETE void | 204 gövdesiz | ✅ |
| G22 | `void`/`Task` **GET** → **200, 204 değil** | `void Ping()` [HttpGet] | GET void→200 boş; sadece DELETE/PUT/PATCH→204, POST→201 | ⚠️ |
| G23 | `StatusCode(n,x)` sabit/const status | `StatusCode(422,e)` | literal+const çözülür → n + gövde=arg1 | ✅ |
| G24 | `StatusCode(n)` gövdesiz | `StatusCode(500)` | status=n, şema yok | ✅ |
| G25 | `Accepted`/`AcceptedAtAction` (202) | | 202, gövde=son arg | ✅ |
| G26 | `Conflict(x)` / `UnprocessableEntity(x)` | | 409/422 + arg0 şema | ✅ |
| G27 | `Unauthorized()` / `Forbid()` | | 401/403 gövdesiz | ✅ |
| G28 | `Problem()` helper | `return Problem(...)` | 500 gövdesiz; **ProblemDetails şeması çıkarılmaz** | ⚠️ |
| G29 | `ValidationProblem()` helper | | 400 gövdesiz; **ValidationProblemDetails şeması çıkarılmaz** | ⚠️ |
| G30 | `Json(x)` / `Content(x)` | | Json→200 json+şema; Content→200 text/plain, şema yok | ✅ |
| G31 | `[ProducesDefaultResponseType]` | | **200 "Default"** olarak emit (OpenAPI `default` anahtarı değil) | ⚠️ |
| G32 | `[ProducesResponseType(Type=..,StatusCode=..)]` named args | | status: named; şema: positional `typeof` önce, yoksa named `Type` | ⚠️ |
| G33 | Collection dönüş `List<T>` / `T[]` | `ActionResult<List<Order>>` | unwrap → ARRAY, items=T | ✅ |
| G35 | `IResult` / `TypedResults.Ok(x)` (controller içinde) | `IResult Get()=>TypedResults.Ok(x)` | ControllerResultReader `TypedResults`/`Results`'ı tanımaz → `IResult` tipsiz → **200 boş, şema kaybı** | ✗ |
| G36 | `[ProducesResponseType]` + gövde birlikte | `[ProducesResponseType(200)]` + `return Ok(dto)` | attribute varsa **gövde yok sayılır** → 200 **gövdesiz** (Ok(dto) şeması kaybolur) | ⚠️ |
| G39 | Derin unwrap sınırı | `Task<ActionResult<...>>` 4+ seviye | 4 iterasyonla sınırlı; aşırı derin sarmalayıcı çözülmez | ⚠️ |
| G40 | `BadRequest(ModelState)` | | 400 + **ModelStateDictionary şeması** (istenmeyen şema riski) | ⚠️ |
| G41 | `<response code="NNN">` XML doc | | eşleşen status description'ı override edilir | ✅ |
| G45 | Nullable dönüş `ActionResult<T?>` / `T?` | | `UnwrapReturnWrappers` Nullable'ı açmaz; response-özel mantık yok | ❓ |

## H. İçerik müzakeresi (content types)

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| H1 | `[Produces("application/json")]` | response content_type (şemalı response'lara) | ✅ |
| H2 | Çoklu `[Produces]` | content_types listesi | ✅ |
| H3 | `[Consumes]` + `[Produces]` birlikte | ikisi de | ✅ |
| H4 | Global JSON adlandırma (camelCase vb.) | property adları config'e göre olmalı; kod **her zaman camelCase** (config okunmaz) | ⚠️ |
| H5 | `File(...)` → `application/octet-stream` | binary response content-type | ✅ |
| H6 | `Content(x)` → `text/plain` | text/plain response | ✅ |
| H7 | `[Produces(typeof(T))]` (string'siz) | content-type override kaydı yok (yalnız string arg okunur) | ⚠️ |
| H8 | Controller-düzeyi `[Consumes]`/`[Produces]` fallback | method yoksa controller'dan | ✅ |

## I. Şema & DTO

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| I1 | `class` DTO → components/schemas + $ref | | dedup, $ref | ✅ |
| I2 | `record` / positional record | `record User(long Id,string Name)` | sentezlenen init-props → OBJECT | ✅ |
| I3 | `struct` / `record struct` DTO | `record struct Money(...)` | class VE struct (record struct dâhil) property'leri okunup hoist edilir → OBJECT + $ref | ✅ |
| I4 | Nullable `string?` / `Nullable<T>` | | nullable:true | ✅ |
| I5 | `required` / init member | `required string X` | required listesi | ✅ |
| I6 | Nested DTO (DTO içinde DTO) | | iç $ref | ✅ |
| I7 | Self-referencing / cyclic tip | `Node{Node Next}` | placeholder ile döngü kırılır, $ref | ✅ |
| I8 | `List`/`T[]`/`IEnumerable`/`ICollection`/`IReadOnly*` | | array | ✅ |
| I9 | `Dictionary<K,V>` / `IReadOnlyDictionary` | | object + additionalProperties | ✅ |
| I10 | `Dictionary<int,V>` (string olmayan key) | | key yoksayılır, value şeması additionalProperties | ⚠️ |
| I11 | Generic DTO `Page<T>` | | somutlaşır, element çözülür; ad = `Page` | ✅ |
| I12 | İç içe generic `Page<List<User>>` | | recursion ile çözülür | ✅ |
| I13 | int/long/short/byte/uint | | integer + int32/int64 | ✅ |
| I14 | decimal/double/float | | number + format | ✅ |
| I15 | DateTime/DateTimeOffset/DateOnly/TimeOnly | | string + date-time/date/time | ✅ |
| I16 | `Guid` | | string uuid | ✅ |
| I17 | `Uri` | | string uri | ✅ |
| I18 | `TimeSpan` | | string **`time`** (duration olmalı; TimeOnly ile aynı format'a düşer) | ⚠️ |
| I19 | `object` / `dynamic` / `JsonElement`/`JsonNode`/`JObject` | | boş `{}` OBJECT (serbest form) | ✅ |
| I20 | Tuple / `ValueTuple` | `(int Count,string Name)` | element-property'li inline OBJECT (adsız → `Item1/Item2`) | ✅ |
| I20b | Public **field** | `public int X;` | STJ field'ları atlar; yalnız `[JsonInclude]` dahil (STJ-doğru) | ✅ (tasarım) |
| I20c | `IAsyncEnumerable<T>` | | ARRAY | ✅ |
| I21 | `[JsonPropertyName]` yeniden adlandırma | | property adı + required listesi değişir | ✅ |
| I22 | Newtonsoft `[JsonProperty]` | `[JsonProperty("x")]` | property adı değişir | ✅ |
| I23 | `[JsonIgnore]` (koşulsuz) | | şemadan çıkar; koşullu (WhenWritingNull) kalır | ✅ |
| I24 | Read-only / computed property | `=> X` | dahil (get var, set şartı yok) | ✅ |
| I25 | Static / const üye | | hariç | ✅ |
| I26 | Field (plain, JsonInclude yok) | | hariç | ✅ |
| I27 | Aynı ad, farklı namespace | `A.Order` / `B.Order` | ikincisi namespace segmentiyle qualify edilir (deterministik) | ✅ |
| I28 | Çok derin nesting (10+) | | çökme yok (her tip bir kez hoist) | ✅ |
| I29 | **Global `JsonNamingPolicy`** (snake_case / PascalCase / null) | `PropertyNamingPolicy = SnakeCaseLower` | semantik tarama politikayı tespit eder; property adları ona göre (Snake/Kebab Lower/Upper, `null`=as-is), yoksa camelCase; per-property override her zaman öncelikli | ✅ |
| I30 | `byte[]` → base64 | `byte[] Data` | string + format `byte` | ✅ |
| I31 | `decimal` format | `decimal Price` | number + format **`decimal`** (OpenAPI-standart değil; tooling sorunu) | ⚠️ |
| I32 | `char` | `char Grade` | string (`maxLength:1` **yok**) | ⚠️ |
| I33 | `HashSet<T>` / `ISet<T>` | | ARRAY (`uniqueItems` **yok** — set semantiği kaybolur) | ⚠️ |
| I34 | `Task<T>`/`ValueTask<T>`/`ActionResult<T>` unwrap (tip) | | iç tipe çözülür | ✅ |
| I35 | `IFormFile` / `IFormFileCollection` → binary | | string binary / array binary | ✅ |
| I36 | Aynı generic'in çok somutlaşması | `Page<Item>` + `Page<Order>` | ikisi de `Page` ister → namespace-qualify ile ayrışır (tip-arg tabanlı `PageOfItem` **değil**) → belirsiz ad | ⚠️ |

## J. Enum

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| J1 | Enum default (numeric) | integer int32 + değer literalleri | ✅ |
| J2 | Global `JsonStringEnumConverter` | string + isimler | ✅ |
| J2b | Generic `JsonStringEnumConverter<T>` (.NET 8) | `OriginalDefinition` FQN eşleşir → string | ✅ |
| J2c | Converter yorumda/testte geçiyor | semantik/ObjectCreation tabanlı → false positive yok | ✅ |
| J3 | `[JsonConverter(typeof(JsonStringEnumConverter))]` | string | ✅ |
| J4 | `[Flags]` enum | yalnız tekil üye değerleri; **kombinasyon temsil edilmez, `[Flags]` okunmaz** | ⚠️ |
| J5 | Explicit değerli enum (`= 5`) | ConstantValue kullanılır | ✅ |
| J6 | Enum üyesinde `[EnumMember]`/`[JsonPropertyName]` | yalnız string modunda isim override | ✅ |
| J7 | Nullable enum `Status?` | enum şeması + nullable | ✅ |
| J8 | Enum underlying `long`/`ulong` | integer int64 | ✅ |
| J9 | Enum üyesinde Newtonsoft `[JsonProperty]` | ad override okunmaz (yalnız JsonPropertyName + EnumMember) | ⚠️ |

## K. Inheritance & Polymorphism

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| K1 | Türetilmiş sınıf miras property'leri içerir | inherited props inline | ✅ |
| K2 | `[JsonPolymorphic]`+`[JsonDerivedType]` | oneOf + discriminator + mapping | ✅ |
| K3 | Custom discriminator adı (`TypeDiscriminatorPropertyName`) | doğru discriminator (yoksa `$type`) | ✅ |
| K4 | Abstract base + çok türev | oneOf tüm türevler | ✅ |
| K5 | `allOf` inheritance stili | **tasarım:** miras allOf değil, inline flatten | ✅ (tasarım) |
| K6 | Interface tipi property `IShape` (polymorphic olmayan) | interface class değil → **boş `{}` OBJECT** (oneOf çözümü yok) | ⚠️ |
| K7 | Derin miras zinciri (3+) | tüm props toplanır (Object'e kadar) | ✅ |
| K8 | Polymorphic base'e-tipli property | `Animal Pet` → hoist edilmiş oneOf'a REFERENCE | ✅ |

## L. Data annotations → constraints

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| L1 | `[Required]` (DTO property) | required listesi | ✅ |
| L1b | `[Required] string? x` (nullable + Required) — property | `HasRequired` nullability'yi ezer → required | ✅ |
| L1c | `[Required] string? x` — **action parametresi** | parametre seviyesinde de required | ✅ |
| L2 | `[StringLength(120,MinimumLength=3)]` | maxLength + minLength | ✅ |
| L3 | `[MinLength]`/`[MaxLength]` (string) | min/maxLength | ✅ |
| L3b | `[MinLength]`/`[MaxLength]` **koleksiyon** | `[MaxLength(10)] int[]` | minItems/maxItems olmalı; kod **her zaman minLength/maxLength** (tip ayrımı yok) | ⚠️ |
| L4 | `[Range(1,100)]` int | minimum/maximum | ✅ |
| L5 | `[Range(0.01,1e6)]` double | number bounds | ✅ |
| L6 | `[RegularExpression]` | pattern | ✅ |
| L7 | `[EmailAddress]` | format email | ✅ |
| L8 | `[Url]` | format uri | ✅ |
| L9 | `[Phone]` | format `phone` (standart OpenAPI formatı değil) | ⚠️ |
| L10 | `[DataType(DataType.Date)]` | format date (ordinal→format map) | ✅ |
| L10b | `[DataType]` desteklenmeyen üye | CreditCard/Currency/PostalCode/Custom → format=null (yoksayılır) | ⚠️ |
| L11 | `[Range(..,MinimumIsExclusive=true)]` (.NET8) | exclusiveMinimum/Maximum (test yok) | ✅ |
| L11b | `[Range(typeof(decimal),"0","100")]` Type-tabanlı | decimal/DateTime aralığı için standart; `AsDouble`=null → **hiç constraint emit edilmez** | ✗ |
| L12 | `[Compare]`/`[CreditCard]` | switch'te case yok → sessizce yoksayılır (çökme yok) | ✅ |
| L13 | Method param üzerinde annotation | `[Range(1,100)] int size` | param constraint uygulanır | ✅ |
| L14 | `[Length(min,max)]` (.NET8) koleksiyon | minItems/maxItems | ✅ |
| L15 | `[Length(min,max)]` (.NET8) **string** | `[Length(3,10)] string` | minLength/maxLength olmalı; kod **minItems/maxItems** (tip ayrımı yok) | ⚠️ |
| L16 | `[AllowedValues]`/`[DeniedValues]` (.NET8) | enum'a çevrilebilir; **hiç işlenmiyor** | ✗ |
| L17 | `[DefaultValue(...)]` | `Schema.DefaultValue` alanı + emitter hazır ama analyzer **doldurmuyor** | ✗ |
| L18 | `[ReadOnly(true)]` | `readOnly` alanı IR'de yok → işlenmez | ✗ |
| L19 | Custom `ValidationAttribute` | bilinmeyen → sessizce yoksayılır (çökme yok) | ✅ |
| L20 | FluentValidation (`AbstractValidator<T>`) | ayrı sınıf/kural → statik attribute okuması göremez | ✗ (yapısal sınır) |
| L21 | `[ApiController]` otomatik ModelState 400 | invalid body → otomatik 400/ProblemDetails; **üretilmez** (yalnız explicit) | ✗ |
| L22 | `required` keyword (C# 11) | NRT/required kuralıyla required | ✅ |
| L23 | Non-nullable value type, `[Required]` yok | implicit required | ✅ |
| L24 | Non-nullable ref (NRT), `[Required]` yok | implicit required | ✅ |
| L25 | `Nullable<T>` value type, `[Required]` yok | required değil | ✅ |
| L27 | Çoklu annotation aynı üyede birleşir | hepsi tek şemada merge | ✅ |

## M. Auth & security

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| M1 | Controller `[Authorize]` | http/bearer JWT, id=`bearerAuth` | ✅ |
| M2 | `[AllowAnonymous]` override | auth null (method+class+base zinciri) | ✅ |
| M3 | Method `[Authorize]` | endpoint güvenliği | ✅ |
| M6 | Base controller `[Authorize]` kalıtımı | base zincirinden okunur | ✅ |
| M7 | `[Authorize(Roles=…)]` / Policy | Roles **yoksayılır**; Policy yalnız id'ye eklenip dedup'a girer, scope/role emit edilmez | ⚠️ |
| M8 | `[Authorize(AuthenticationSchemes=…)]` | scheme adına göre tip eşlenir | ✅ |
| M9 | API key auth | apiKey scheme; ama header adı kurtarılamaz → sabit; query API key yok | ⚠️ |
| M10 | OAuth2 / OpenIdConnect | tip emit edilir **ama `flows`/`openIdConnectUrl` YOK** → 3.1 açısından geçersiz scheme | ⚠️ |
| M12 | Çoklu auth şeması aynı specte | id başına ayrı scheme, dedup | ✅ |
| M13 | Bearer dedup (aynı scheme) | tek `bearerAuth` | ✅ |
| M14 | Basic auth (`AuthenticationSchemes="Basic"`) | http/basic, id=`basicAuth` | ✅ |
| M15 | Cookie auth (`="Cookies"`) | Cookie case yok → default'a düşer, **yanlışlıkla bearer** | ✗ |
| M16 | Tek attribute'te çoklu scheme | `="Bearer,Cookie"` | yalnız **ilk** scheme kullanılır, ikincisi düşer | ⚠️ |
| M17 | `[RequireHttps]` | hiç okunmaz; server/scheme etkisi yok | ✗ |
| M19 | oauth2/oidc scheme **geçerliliği** | zorunlu `flows`/`openIdConnectUrl` eksik → validator hata verir | ✗ (kritik) |
| M20 | `[Authorize(Policy=…)]` + açık scheme | Policy id'ye eklenmez → policy ayrımı kaybolur | ✗ |
| M21 | Global vs per-operation security | yalnız operation seviyesinde; belge kökü `security` yok | ⚠️ (tasarım notu) |

## N. Dokümantasyon & metadata

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| N1 | `<summary>` → operation summary | | ✅ |
| N2 | `<remarks>` → description | | ✅ |
| N3 | `<param name>` → parametre açıklaması | | ✅ |
| N4 | Inline tag'ler `<c>/<see cref/langword/href>/<paramref>` | düz metne indirgenir | ✅ |
| N5 | Çok satırlı / markdown remarks | satırlar `\n` ile korunur ama **her satır trim'lenir** → kod bloğu/girinti bozulur | ⚠️ |
| N6 | DTO property üzerinde XML doc | SchemaInference doc XML **hiç okumaz** → Schema.Description boş | ✗ |
| N7 | `<returns>` → response açıklaması | `XmlDocReader.Returns` parse edilir ama **hiç tüketilmez** | ✗ |
| N8 | `<response code="404">` | ilgili status description override | ✅ |
| N9 | Action metodunda XML doc | okunur | ✅ |
| N10 | Eksik/bozuk XML doc | try/catch → boş, çökme yok | ✅ |
| N11 | `[Obsolete]` → deprecated | `deprecated:true` (controller → tüm action'lar) | ✅ |
| N12 | operationId üretimi | method adı; belge genelinde dedup (tag_ öneki, sonra sayısal) | ✅ |
| N13 | Tag çıkarımı controller adından | `UsersController` → "Users" | ✅ |
| N14 | `[Tags("x")]` override | yoksayılır; tag **daima** controller adından | ✗ |
| N15 | Swashbuckle `[SwaggerOperation]`/`[SwaggerResponse]`/`[SwaggerSchema]` | hiç okunmaz → açıklamalar kaybolur | ✗ |
| N16 | NSwag attribute'ları | desteklenmez | ✗ |
| N17 | `[EndpointName]`/`[EndpointSummary]`/`[EndpointDescription]` | okunmaz | ✗ |
| N18 | `[Description]` (System.ComponentModel) | okunmaz | ✗ |
| N19 | Example değerleri (`<example>`, `[DefaultValue]`) | analyzer `Example`'ı **hiç doldurmaz** (IR alanı + generator emit var, no-op) | ✗ |
| N20 | `[ProducesResponseType]` açıklaması | yalnız generic status metni; attr'daki açıklama/.NET9 Description okunmaz | ⚠️ |
| N21 | `[ApiExplorerSettings(GroupName=…)]` → tag/grup | yalnız `IgnoreApi` onurlandırılır; GroupName yansımaz | ✗ |

## O. Tanılama, diagnostics & --strict

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| O1 | Parse edilemeyen endpoint → W-diagnostic | route düşmez, uyarı | ⚠️ |
| O2 | `--strict` + error severity | strict kontrolü 0-route'tan önce; error>0 → exit 1 | ✅ |
| O3 | `--strict` yokken error | çıktı yine üretilir | ✅ |
| O4 | 0 route bulundu | "0 routes", exit 1 | ✅ |
| O5 | Diagnostic emisyon envanteri | emit edilenler: **W003, W004, W007, E001**; W005 tanımlı ama emit edilmiyor | ⚠️ |
| O5b | MVC sessiz atlama | açık generic → W004; **abstract controller sessiz** (uyarısız) | ⚠️ |
| O6 | Kısmen parse edilebilen proje | parse edilenler + uyarılar | ❓ |
| O7 | Derlenmeyen C# (syntax hatası) | Roslyn kısmi derleme; hatalı controller yine walk edilir, çökme yok | ⚠️ |
| O8 | Eksik referans/paket | W003; tipler `ErrorType` → şema `object`/atlama, çökme yok | ⚠️ |
| O9 | **E001 `--strict` yolunda CLI'da yakalanamıyor** | Program E001'i stdout'a yazıp exit 1 döner AMA bridge non-zero exit'te stdout okumadan `AnalyzerCrashedError` fırlatır → CLI E001'i göremez (kod ile niyet çelişir) | ✗ |

## P. Analyzer subprocess & bridge

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| P1 | Analyzer bulunamadı (build edilmemiş) | `AnalyzerNotFoundError`, exit 2 | ✅ |
| P2 | Analyzer çöktü (non-zero) | `AnalyzerCrashedError` + stderr tail, exit 1 | ✅ |
| P3 | Bozuk/parse edilemeyen JSON stdout | `AnalyzerOutputError`, exit 1 | ✅ |
| P4 | IR zod doğrulaması başarısız (drift) | `IRValidationError` → `AnalyzerOutputError` | ✅ |
| P5 | Çok büyük stdout (binlerce route) | spawn + chunk stream, maxBuffer yok → yalnız bellek-sınırlı | ✅ |
| P6 | Analyzer takılması | 120s timeout → kill → exit 124 → `AnalyzerCrashedError` | ✅ |
| P7 | `dotnet` PATH'te yok (ENOENT) | dostça `DotnetNotFoundError` (".NET SDK not found…"), exit 1 | ✅ |
| P8 | `REFERENCE` şeması `refName`'siz | generator guard: boş `{}` | ✅ |
| P9 | Boş stdout, exit 0 | "exited cleanly but produced no JSON" → `AnalyzerOutputError` | ✅ |
| P10 | `ASTRONAUT_DOTNET_ANALYZER` env override yolu yok | override set ama dosya yok → `AnalyzerNotFoundError` (fallback aranmaz) | ⚠️ |

## Q. Çıktı formatı & determinizm

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| Q1 | Varsayılan YAML çıktı | geçerli YAML | ✅ |
| Q2 | `--json` | geçerli JSON | ✅ |
| Q3 | `-o dosya` | dizin oluşturur, yazar | ✅ |
| Q4 | stdout (o yok) | stdout'a yazar | ✅ |
| Q5 | `--title` / `--version-tag` override | info.title/version | ⚠️ |
| Q6 | Override yoksa csproj'dan title/version | `<AssemblyName>`/`<Version>`/`<Description>` regex; çok-satırlı tag desteklenmez; solution → title=`.sln` adı, version `0.0.0` | ⚠️ |
| Q7 | Determinizm | tek proje: route sırası = kaynak sırası (kararlı); **çoklu proje `.sln`: `solution.Projects` sıralanmıyor** → proje-arası sıra Roslyn enumerate'ine bağlı | ⚠️ |
| Q8 | operationId çakışması dedup | benzersiz operationId | ✅ (e2e invariant) |
| Q9 | Duplicate parametre engellenir | benzersiz param | ✅ (e2e invariant) |
| Q10 | Çıktı OpenAPI 3.1 meta-şema geçerli | valid | ✅ (e2e) |
| Q11 | Şema adı çakışması | aynı simple-name farklı ns → namespace-qualify (`OrderingOrder`); hangi tipin "bare" adı aldığı keşif sırasına bağlı (U22) | ⚠️ |

## R. Çoklu proje / solution

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| R1 | `.sln` her csproj analiz | her C# projesi için ayrı walker, birleştirilir; C#-dışı atlanır | ⚠️ |
| R2 | DTO bir kez hoisted (paylaşımlı) | tek `SchemaContext`; **AMA** dedup `SymbolEqualityComparer` → farklı derlemelerdeki aynı tip **farklı symbol** → dedup ıskalar → **duplike/namespace-qualified ikinci kopya** | ⚠️ |
| R3 | İki projede aynı isimli farklı DTO | namespace-qualify ile ayrışır (R2 kök-nedeni ile karışabilir) | ⚠️ |
| R4 | Web olmayan class lib | derlenir, controller yoksa 0 route; DTO'ları bir controller kullanırsa şemaya girer | ✅ |
| R5 | `.slnx` yeni format | `XDocument` ile parse; bozuk .slnx → dizin taramasına düşüş | ✅ |
| R6 | Projeler arası tip referansı | metadata referans → symbol çözülür (R2 dedup sınırı geçerli) | ⚠️ |
| R7 | `.sln` açılamadı / boş solution | `OpenSolutionAsync` exception → W003 + csproj taraması; solution asla hard-fail değil | ✅ |
| R8 | Dairesel proje referansı | MSBuild grafiği kurar; şema döngüsü placeholder ile kırılır | ⚠️ |

## S. Performans & ölçek

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| S1 | 100+ endpoint tek proje | per-tree semantic model, lineer; makul | ❓ |
| S2 | 500+ DTO | dedup, bellek | ❓ |
| S3 | Büyük solution (10+ proje) | **sıralı `await`** (paralel değil) → büyük sln'de yavaş olabilir ama tamamlanır | ⚠️ |
| S4 | Derin/dairesel şema grafiği | cycle-safe placeholder → sonsuz döngü yok | ✅ |
| S5 | Çok büyük monorepo dizin taraması | `EnumerateFiles(AllDirectories)` tüm ağaç (bin/obj hariç), sınır yok → I/O ağır olabilir | ❓ |

## T. OpenAPI 3.1 geçerlilik invariant'ları (her canlı koşuda)

Her canlı testte çıktı üzerinde otomatik kontrol edilmesi gerekenler:

- [ ] OpenAPI 3.1 meta-şemasına göre **valid**.
- [ ] Tüm `operationId`'ler **benzersiz**.
- [ ] Bir operasyonda `{in,name}` bazında **duplicate parametre yok**.
- [ ] Her `$ref` `components/schemas` altında **çözümleniyor** (dangling ref yok).
- [ ] Path template'deki her `{param}` için bir path parametresi **var** (ve tersi).
- [ ] `securitySchemes`'e referans veren her `security` **tanımlı** (ve oauth2/oidc şemaları `flows`/`openIdConnectUrl` taşıyor — bkz. M19).
- [ ] Nullable, 3.1 tarzı (`type: [..., "null"]`) emit ediliyor.
- [ ] Boş/`null` şema üretilmiyor (her schema geçerli bir kind taşıyor).

## V. Diğer paradigmalar & cross-cutting

Analyzer yalnızca `[ApiController]` veya `ControllerBase`/`Controller` türevi sınıfları walk eder; diğer her şey görünmezdir. "Sessizce yanlış üretme, tercihen W-diagnostic" ilkesini en çok zorlayan alan burasıdır.

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| V1 | gRPC servisi (`X : MyServiceBase`) | controller değil → sessizce atlanır, 0 route | ✅ (graceful) |
| V2 | SignalR Hub (`X : Hub`) | sessizce atlanır | ✅ (graceful) |
| V3 | GraphQL (HotChocolate resolver) | sessizce atlanır | ✅ (graceful) |
| V4 | **OData controller** (`X : ODataController`) | `ControllerBase` türevi → **route'lar emit edilir** ama OData `$filter`/`[EnableQuery]` semantiği yoksayılır (yanıltıcı çıktı) | ⚠️ |
| V5 | BackgroundService / IHostedService | sessizce atlanır | ✅ (graceful) |
| V6 | Minimal API (`app.MapGet`) | kaldırıldı; walk edilmez → sessizce yok sayılır | ✅ |
| V7 | DI kaydı (`Program.cs` `builder.Services…`) | `Program.cs` **hiç analiz edilmez**; servis-mi kararı yalnız tip-heuristiği (container görünmez) | ⚠️ |
| V8 | Global exception handler / ProblemDetails middleware | middleware görünmez; yalnız imza-düzey `[ProducesResponseType(ProblemDetails)]` yansır | ✗ |
| V9 | CORS (`AddCors`/`[EnableCors]`) | middleware/attribute okunmaz → yansımaz (sessiz) | ✗ |
| V10 | Rate limiting (`[EnableRateLimiting]`) | attribute okunmaz, yansımaz (sessiz) | ✗ |
| V11 | Pagination convention | `PagedResult<T>` dönüş tipi şemaya girer; `?page=` yalnız gerçek parametreyse yakalanır (konvansiyon/middleware değil) | ⚠️ |

---

## Kaynak-doğrulanmış boşluk sıralaması (2026-08 kapsamlı tarama)

7-ajan taramasının ürettiği, **koddan doğrulanmış** boşluklar. Öncelik: sessizce
**yanlış çıktı** üretenler > eksik özellikler > gözlemlenebilirlik. Standart API
derinleşmesinin sonraki increment adayları bunlardır.

### Grup 1 — Sessiz YANLIŞ çıktı (en yüksek öncelik)

| Ref | Boşluk | Etki |
| --- | --- | --- |
| E3/E19 | `[FromHeader/FromQuery/FromRoute(Name="...")]` ad override yok sayılıyor | kebab-case header/query adları C# adıyla çıkar (`X-Trace-Id` → `traceId`) — çok yaygın |
| G36 | `[ProducesResponseType]` + gövde birlikte → şema kaybı | `[ProducesResponseType(200)]` + `return Ok(dto)` → 200 gövdesiz; en sık kalıp |
| E12 | `[AsParameters]` flatten edilmiyor → tüm struct body'ye | GET action'da tümüyle yanlış operasyon şekli |
| B32 | `[MapToApiVersion]` → controller'ın tüm versiyonlarına fan-out | var olmayan `/vX/...` route'ları uydurur |
| I3 | struct / `record struct` DTO → boş `{}` | `Money`/`Coordinate` value-object property'leri kaybolur |
| I29 | Global `JsonNamingPolicy` yok sayılıyor (hep camelCase) | snake_case/PascalCase API'lerde tüm wire adları yanlış |
| L3b/L15 | Koleksiyon uzunluğu yanlış eşleniyor | `[MaxLength(10)] string[]` → maxLength (dizide anlamsız); `[Length] string` → minItems |
| M19 | oauth2/oidc scheme `flows`/`openIdConnectUrl`'siz | üretilen spec bu şemalarda validator'dan geçmez |
| R2/R6 | Çoklu-proje DTO dedup derleme sınırında bozuk | aynı DTO iki projede → duplike/şişmiş `components/schemas` |

### Grup 2 — Eksik özellik (kapsam genişletme)

| Ref | Boşluk |
| --- | --- |
| B18–B22 | Conventional routing, method/class çoklu `[Route]`, verb'siz `[Route]`, area, `~/` override |
| B28–B30, B33–B34 | Query/header/media-type versiyonlama, deprecated versiyon, action-level `[ApiVersion]` |
| G35 | Controller içinde `IResult`/`TypedResults`/`Results` tanınmıyor |
| G28/G29 | `Problem()`/`ValidationProblem()` → ProblemDetails/ValidationProblemDetails şeması |
| L11b/L16/L17/L21 | `[Range(typeof)]`, `[AllowedValues]`, `[DefaultValue]`, `[ApiController]` otomatik 400 |
| N6/N7/N19 | DTO property XML doc, `<returns>`, `<example>`/örnek değerleri |
| N14–N18 | `[Tags]` override, Swashbuckle/NSwag attribute'ları, `[Description]` |
| M7/M9/M15/M17 | Roles/policy→scope, query API key, cookie auth, `[RequireHttps]` |
| E17/E19/F11 | `[BindRequired]`/`[BindNever]`, `[FromForm]` scalar, `Stream`/octet-stream body |

### Grup 3 — Doğruluk nüansı & gözlemlenebilirlik

| Ref | Boşluk |
| --- | --- |
| I18/I31/I32/I33 | TimeSpan→`time` (duration olmalı), decimal non-standard format, char maxLength yok, HashSet uniqueItems yok |
| J4/J9 | `[Flags]` kombinasyonları, enum üyesinde Newtonsoft ad |
| D10–D12 | `{id?}`/`{id=5}`/`{*rest}` opsiyonellik/default/catch-all semantiği düzleşiyor |
| G22/G39 | void GET→200 (204 değil), 4-seviye unwrap sınırı |
| O9 | E001 `--strict` yolunda CLI'da tüketilemiyor (mimari tutarsızlık) |
| W005 | `UnresolvedResult` hâlâ emit edilmiyor (güvenli tetikleyici gerek) |
| V4/V8/V9/V10 | OData yanıltıcı emit; CORS/rate-limit/exception-middleware sessiz — en azından "kapsam dışı" info diagnostic |

### Test-boşluğu notu

Data-annotation **constraint değerlerini** (minLength/maxLength/pattern/format) assert
eden **hiçbir birim test yok** (yalnız fixture var, assertion yok). L2–L11 "✅"
durumları kod-yolu + emit boru hattına dayanıyor, regresyon testine değil.

---

## U. Kaynak-doğrulanmış bulgular (Round 1 tarihsel)

Aşağıdakiler Round 1'de (PR #8–#17) koddan doğrulanıp koda alınan bulgulardır.
Tarihsel kayıt olarak korunur; güncel kapsamlı boşluk listesi için yukarıdaki
**"Kaynak-doğrulanmış boşluk sıralaması"na** bakın.

### U.1 — Kesin bug'lar (yanlış çıktı üretir)

| # | Bulgu | Durum (Round 1) |
| --- | --- | --- |
| U1 | `TypeClassifier.IsSimpleType` enum'ı **simple** saymıyor → enum param body'ye bağlanır | ✅ WS1/#8 (enum artık query/path) |
| U2 | DI **concrete class** servisi interface değil → body'ye sızar | ✅ WS1/#8 (bindable-yüzeysiz sınıf = servis heuristiği) |
| U3 | `[Required]` DataAnnotation required'lık için kullanılmıyor | ✅ WS4/#13 (`HasRequired` + nullability) |
| U4 | Public **field**'lar okunmuyor | ✅ WS4/#13 (`[JsonInclude]` field'ları dahil — STJ-doğru) |
| U5 | Tuple / `IAsyncEnumerable<T>` → boş `{}` OBJECT | ✅ WS4/#13 (tuple→OBJECT, IAsyncEnumerable→ARRAY) |
| U6 | Generic `JsonStringEnumConverter<T>` isim eşleşmiyor | ✅ WS5/#9 (semantik tip çözümü) |
| U7 | `JsonStringEnumConverter` salt sözdizimsel taranıyor | ✅ WS5/#9 (semantik → false positive elenir) |
| U8 | `[NonAction]` yoksayılıyor | ✅ WS2/#16 (+ `[ApiExplorerSettings(IgnoreApi)]`) |
| U9 | Non-string `Dictionary` key indirgeniyor | ✅ WS4/#13 (çökme yok, doğrulandı + not) |

### U.2 — Kesin boşluklar (desteklenmiyor; graceful olmalı)

| # | Bulgu | Durum (Round 1) |
| --- | --- | --- |
| U10 | Auth **yalnızca** `http/bearer/JWT` | ✅ WS6/#11 (apiKey/oauth2/openIdConnect eşlemesi; flows/scope ertelendi — bkz. M19) |
| U11 | Base/abstract controller miras action'ları yürünmez | ✅ WS2/#16 (inheritance zinciri + dedup) |
| U12 | Minimal API: `MapMethods`/`Map`/`[AsParameters]`/complex-`[FromQuery]`/group-auth | ⛔ geçersiz — Minimal API kaldırıldı (`feat/remove-minimal-api`) |
| U13 | `object`/`JsonElement`/interface/struct → boş `{}` | — kısmen tasarım (interface/struct için bkz. K6/I3) |
| U14 | `[Range]` exclusive bound & .NET 8 attribute'ları | ✅ WS4/#13 (exclusive range, `[Length]`, DataType tablosu; `[AllowedValues]` ertelendi — bkz. L16) |
| U15 | Return unwrap 4 seviye, sınırlı awaitable | ⚠️ WS7/#14 (çok daha fazla result tipi; unwrap derinliği ertelendi — bkz. G39) |
| U16 | XML doc: `<response code>` / DTO property doc'ları okunmuyor | ✅/⚠️ WS8/#12 (`<response code>` + inline tag; DTO property doc hâlâ ertelendi — bkz. N6) |

### U.3 — Kırılganlık / robustluk noktaları

| # | Bulgu | Durum (Round 1) |
| --- | --- | --- |
| U17 | Çoklu csproj/sln → non-deterministik seçim | ✅ WS9/#10 (`detect.ts`) + WS10/#15 (`ProjectLoader`, sıralı + W007) |
| U18 | `dotnet` yoksa tipsiz "Unexpected error" | ✅ WS9/#10 (dostça `DotnetNotFoundError`) |
| U19 | Analyzer 120s timeout → exit 124 → `AnalyzerCrashedError` | — mevcut davranış (bilgi) |
| U20 | `REFERENCE` `refName`'siz → generator hard throw | ✅ WS9/#10 (guard: boş `{}`) |
| U21 | Aynı path+method iki route → sessiz overwrite | ✅ WS9/#10 (ilkini koru + uyarı) |
| U22 | Aynı simple-name farklı namespace DTO adı sıraya bağlı | ⚠️ WS10/#15 (namespace-türevli kararlı ad; bare-ad sırası hâlâ sıraya bağlı — bkz. Q11) |
| U23 | `--strict` mesajı toplam diagnostic basıyor | ✅ WS9/#10 (error sayısı) |
| U24 | Controller + Minimal aynı route → dedup yok | ⛔ geçersiz — Minimal API kaldırıldı |

### U.4 — Diagnostic envanteri

| Kod | Anlamı | Tetikleyici |
| --- | --- | --- |
| **W003** `WorkspaceLoad` | workspace/solution yükleme sorunu | `.sln`/`.slnx` açılamadı → csproj taramasına düşüş |
| **W004** `SkippedController` | atlanan MVC controller | **emit ediliyor**: non-abstract açık generic controller atlandığında |
| **W005** `UnresolvedResult` | çözülemeyen MVC result body | *tanımlı, henüz emit edilmiyor* (güvenli tetikleyici yok — no-body 204/DELETE ile ayırt edilemiyor) |
| **W007** `MultipleProjects` | dizinde birden çok proje | deterministik seçilen + atlananlar (U17) |
| **E001** `ProjectLoadFailed` | proje/derleme yüklenemedi | `--strict` ile yakalanmalı (ama bkz. O9 — CLI yolunda bozuk) |

> **Not:** W001 (`DynamicRoutePath`), W002 (`UnresolvedHandler`) ve W006 (`DuplicateRoute`)
> yalnızca Minimal API / controller-minimal birleştirme yolundan çıkıyordu; Minimal API
> kaldırıldığında emekliye ayrıldı. Kodlar tarihsel loglar belirsizleşmesin diye yeniden
> kullanılmıyor.

---

## Canlı test için önerilen gerçek projeler

Kapsamı gerçekçi zorlamak için farklı stiller:

1. **Küçük Controllers** — klasik `[ApiController]` CRUD (ör. eShopOnWeb tarzı).
2. **Büyük gerçek dünya** — çok projeli `.sln`, generic'ler, polymorphism, auth (R2 dedup'ı zorlar).
3. **Versiyonlu API** — `Asp.Versioning`, `[MapToApiVersion]` (B32'yi zorlar).
4. **Swashbuckle-yoğun** — `[SwaggerOperation]`/`[Tags]`/`[Description]` metadata (N14–N18).
5. **Zorlayıcı/uç** — R/S/V bölümündeki desteklenmeyen yapıları içeren, "çökmemeli" testi için.

## Öncelik sırası (canlı testte ilk bakılacaklar)

1. **Grup 1 (sessiz yanlış çıktı)** — yukarıdaki boşluk sıralamasının en kritik ekseni;
   gerçek projede sessizce yanlış OpenAPI üreten satırlar.
2. **Round-1 fix doğrulaması (U1–U24 ✅)** — regresyon testi olmayan düzeltmeler.
3. **Grup 2 (eksik özellik)** — kapsam genişletme adayları; canlıda hangisinin sık çıktığını gözle.
4. **Grup 3 + V** — doğruluk nüansı, gözlemlenebilirlik, paradigma körlüğü.

## Sonraki tur (deferred)

- **Regresyon test turu:** her ✅ fix için `TestCompilation.Walk` tabanlı xUnit +
  gerekli e2e fixture; özellikle **data-annotation constraint değerleri** için test yok.
- **Grup 1 correctness increment'i:** ad override (E3), ProducesResponseType+gövde (G36),
  AsParameters (E12), struct DTO (I3), JsonNamingPolicy (I29), koleksiyon uzunluğu (L3b).
- **Kalan özellikler:** conventional routing, versiyonlamanın diğer biçimleri, Swashbuckle
  metadata, oauth2 flows, W005 emisyonu, cross-cutting (V) için kapsam-dışı diagnostic.
