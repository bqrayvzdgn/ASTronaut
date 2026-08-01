# ASTronaut — Canlı Test Senaryoları

> Amaç: ASTronaut'un (ASP.NET Core kaynak → OpenAPI 3.1) gerçek projeler üzerinde
> **canlı** olarak test edileceği senaryoların tam envanteri. Bu doküman bir QA
> test planıdır; her senaryo bir girdi (C# yapısı veya CLI çağrısı) ve beklenen
> çıktı davranışıyla tanımlanır.

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

- ✅ **Kapsanıyor** — özel fixture ve/veya unit test mevcut.
- ⚠️ **Kısmi** — destekleniyor (README) ama izole fixture/test zayıf; canlıda doğrula.
- ❓ **Doğrula** — davranış belirsiz; canlı testin asıl hedefi.
- ✗ **Boşluk** — ASP.NET Core'da yaygın ama muhtemelen desteklenmiyor; regresyon/known-gap adayı.

> Not: ⚠️/❓/✗ satırları canlı testin **öncelikli** hedefleridir. ✗ satırları
> "analyzer düşmeden, sessizce yanlış üretmeden, tercihen bir W-diagnostic ile"
> ele almalı — canlı testte asıl kontrol budur.

---

## A. Proje keşfi & girdi tipleri (CLI/IO)

| ID | Senaryo | Girdi | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| A1 | Dizin içinde tek `.csproj` | `analyze ./app` | csproj bulunur, `project` kind | ✅ |
| A2 | Doğrudan `.csproj` yolu | `analyze ./app/App.csproj` | doğrudan kullanılır | ✅ |
| A3 | Dizin içinde `.sln` | `analyze ./repo` | solution seçilir (csproj'a öncelikli) | ⚠️ |
| A4 | Doğrudan `.slnx` yolu | `analyze ./repo/App.slnx` | solution kind | ⚠️ |
| A5 | Solution + csproj birlikte | dizinde hem `.sln` hem `.csproj` | `.sln` kazanır | ❓ |
| A6 | İç içe / derin dizinde csproj | `analyze ./repo` (csproj alt klasörde) | DFS bulur | ❓ |
| A6b | Dizinde **birden çok** csproj/sln | | **first-wins, dosya sistemi sırasına bağlı → non-deterministik seçim**, sadece stderr uyarı | ✗ |
| A7 | `bin`/`obj`/`node_modules` atlanır | build artefaktı olan dizin | bu klasörler atlanır | ✅ |
| A8 | Var olmayan yol | `analyze ./yok` | "No supported project", exit 1 | ✅ |
| A9 | Analyzable olmayan dizin | boş klasör / sadece `.txt` | exit 1 | ✅ |
| A10 | Sadece `bin`/`obj` içeren dizin | derlenmiş ama kaynak yok | tespit edilmez / 0 route | ❓ |
| A11 | Çok büyük monorepo | binlerce dosya | ilk csproj/sln, makul süre | ❓ |
| A12 | Boşluk/Unicode içeren yol | `analyze "C:\Proje Ç"` | doğru çalışır | ❓ |
| A13 | Göreli vs mutlak yol | `./app` vs `C:\...\app` | `resolve` ile aynı sonuç | ⚠️ |

## B. Routing — Controllers

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| B1 | `[ApiController]` + `[Route]` + `[HttpGet]` | UsersController | route emit edilir | ✅ |
| B2 | Tüm HTTP verb'leri | Get/Post/Put/Delete/Patch | her biri ayrı operation | ✅ |
| B3 | `[HttpHead]` / `[HttpOptions]` | | **desteklenir** (verb map'te); `[HttpTrace]`/`[HttpConnect]` **yok** | ⚠️ |
| B4 | `[Route("[controller]")]` token | `api/v1/[controller]` | controller adı ile değişir | ✅ |
| B5 | `[controller]` + `[action]` token | `[controller]/[action]` | action adı ile değişir | ❓ |
| B6 | Sınıf düzeyi + method düzeyi route birleşimi | `[Route("api")]`+`[HttpGet("x")]` | `api/x` | ✅ |
| B7 | Method üzerinde birden çok Http attribute | `[HttpGet("a")][HttpPost("b")]` | **her biri ayrı route** (loop) — onaylandı | ✅ |
| B8 | `[Route]` verb attribute olmadan | sadece `[Route]` | davranış? | ❓ |
| B9 | Absolute path override (`/health`) | `[HttpGet("/health")]` | controller route yoksayılır | ✅ |
| B10 | `[ApiController]` olmayan controller | plain `Controller` | emit edilir mi? | ❓ |
| B11 | `ControllerBase` yerine `Controller` (MVC View) | | API mı sayılır? | ❓ |
| B12 | Abstract/base controller'dan miras action | base sınıfta `[HttpGet]` | **desteklenmiyor:** sadece `type.GetMembers()`, base action'lar yürünmez | ✗ |
| B13 | Generic controller | `Ctrl<T>` | davranış? | ✗ |
| B14 | `[ApiVersion]` / versiyonlu route | Asp.Versioning | desteklenmiyor | ✗ |
| B15 | `[NonAction]` public method | | **BUG:** `[NonAction]` yoksayılıyor; Http attribute'lu ise yine route üretir | ✗ |
| B16 | Private/protected action | | route üretilmemeli | ❓ |
| B17 | `[AcceptVerbs]` çoklu verb | | davranış? | ✗ |

## C. Routing — Minimal API

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| C1 | `app.MapGet/Post/Put/Delete/Patch` | minimal-api-basic | her biri route | ✅ |
| C2 | `MapGroup` prefix | `app.MapGroup("/api")` | prefix birleşir | ✅ |
| C3 | İç içe `MapGroup` | `api.MapGroup("/users")` | prefix'ler zincirlenir | ✅ |
| C4 | Inline chained MapGroup | `api.MapGroup("/x").MapGet(...)` | çözülür | ✅ |
| C5 | Inline lambda handler | `() => ...` | çözülür | ✅ |
| C6 | Method-reference handler | `UserHandlers.Delete` | hedef method okunur | ✅ |
| C7 | Fluent: `WithName/WithTags/WithSummary/WithDescription` | | metadata'ya map | ✅ |
| C8 | `WithOpenApi(...)` özelleştirme | operation transform | desteklenmiyor | ✗ |
| C9 | `MapMethods(["GET","POST"], ...)` | | çoklu verb | ❓ |
| C10 | `Map(pattern, handler)` (verb'siz) | | davranış? | ❓ |
| C11 | Değişkene atanmış handler `var h = () => ...` | | çözülür mü | ❓ |
| C12 | Ayrı sınıftaki static handler grubu | `RouteGroupBuilder` extension | ❓ |
| C13 | Extension method ile endpoint kayıt | `app.MapUserEndpoints()` | takip edilmez | ✗ |
| C14 | `builder.Services...` DI zinciri gürültüsü | Program.cs setup | route değil, atlanır | ✅ |
| C15 | Koşullu map (`if (env) app.MapGet`) | | route çıkarılır mı | ❓ |
| C16 | Döngü içinde map | `foreach(... app.MapGet)` | statik analiz sınırı | ✗ |
| C17 | `MapControllers()` + minimal karışık | aynı projede ikisi | ikisi de emit | ❓ |

## D. Route template & constraint'ler

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| D1 | Basit param | `{id}` | path param, string | ✅ |
| D2 | `int` constraint | `{id:int}` | integer | ✅ |
| D3 | `int:min(1)` | `{id:int:min(1)}` | integer + minimum | ✅ |
| D4 | `guid` | `{uuid:guid}` | string, format uuid | ✅ |
| D5 | `alpha:length(3,40)` | slug | string + min/maxLength | ✅ |
| D6 | `long` | `{id:long}` | integer int64 | ✅ |
| D7 | `bool` / `datetime` / `decimal` / `double` | | doğru primitive+format | ❓ |
| D8 | `max(n)`, `range(a,b)`, `minlength/maxlength` | | constraint'e map | ❓ |
| D9 | `regex(...)` constraint | `{code:regex(^[A-Z]+$)}` | pattern | ❓ |
| D10 | Opsiyonel param `{id?}` | | required=false | ❓ |
| D11 | Default değerli `{id=5}` | | required=false + default | ❓ |
| D12 | Catch-all `{*rest}` / `{**rest}` | | davranış? | ❓ |
| D13 | Tek segmentte çok param `{y}-{m}-{d}` | | hepsi ayrı path param | ❓ |
| D14 | Custom constraint (bilinmeyen) | `{id:mycustom}` | string fallback + no crash | ❓ |
| D15 | Query string route template'de yok | | path only | ✅ |

## E. Parametreler & binding

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| E1 | `[FromRoute]` | | path param | ✅ |
| E2 | `[FromQuery]` | | query param | ✅ |
| E3 | `[FromHeader(Name="X-Trace-Id")]` | | header param, doğru ad | ✅ |
| E4 | `[FromBody]` | | request body | ✅ |
| E5 | `[FromForm]` / `IFormFile` | | multipart/form-data + binary | ⚠️ |
| E6 | Attribute'suz basit param → query çıkarımı | `int page = 1` | query param | ✅ |
| E7 | Attribute'suz complex tip → body çıkarımı | `CreateDto dto` | body | ✅ |
| E8 | Nullable param `string? q` | | required=false | ✅ |
| E9 | Default değerli param `int size = 20` | | required=false | ✅ |
| E10 | Minimal API'de path param eşleşmesi | `(long id)` + `{id:long}` | path param | ✅ |
| E11 | Minimal API DI parametreleri body sayılmamalı | `HttpContext`, `CancellationToken`, `[FromServices]`, `IService` | atlanır (interface'ler) | ✅ |
| E11b | **Concrete class** service (`AppDbContext`) | ctor DI ama attribute yok | **BUG:** interface değil → service sayılmaz → body'ye bağlanır | ✗ |
| E12 | `[AsParameters]` struct binding | | her alan ayrı param | ❓ |
| E13 | `[FromKeyedServices]` | | atlanır (switch'te var) | ✅ |
| E14 | Array/list query `[FromQuery] int[] ids` | | array query param | ❓ |
| E15 | Enum query param | `[FromQuery] Status s` | **BUG:** `TypeClassifier.IsSimpleType` enum'ı simple saymaz → body'ye yanlış bağlanır | ✗ |
| E16 | Aynı isimli path+query çakışması | | duplicate param invariant korunur | ✅ |
| E17 | `[BindRequired]` / `[BindNever]` | | required / atla | ❓ |
| E18 | Complex tip `[FromQuery]` (nested binding) | | properties → query | ❓ |

## F. Request body

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| F1 | `[FromBody] Dto` | | application/json body, schema $ref | ✅ |
| F2 | Body required/optional | nullable dto | required doğru | ❓ |
| F3 | Body olarak List/array | `[FromBody] List<T>` | array schema | ❓ |
| F4 | Body olarak primitive | `[FromBody] string` | string body | ❓ |
| F5 | `IFormFile` tek dosya | | binary format | ⚠️ |
| F6 | `IFormFileCollection` / `List<IFormFile>` | | array binary | ❓ |
| F7 | `[Consumes("application/xml")]` | | content_type override | ⚠️ |
| F8 | Çoklu `[Consumes]` | | content_types listesi | ⚠️ |
| F9 | GET + body (anti-pattern) | | davranış? | ❓ |

## G. Response & status kodları

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| G1 | `ActionResult<T>` dönüş | | 200 + T şeması | ✅ |
| G2 | `IActionResult` (tipsiz) | | 200 default / boş | ✅ |
| G3 | `[ProducesResponseType(typeof(T),200)]` | | 200 + T | ✅ |
| G4 | `[ProducesResponseType(404)]` (gövdesiz) | | 404 açıklama | ✅ |
| G5 | `[ProducesResponseType<T>(201)]` generic | | 201 + T | ✅ |
| G6 | Çoklu ProducesResponseType | 200+400+404 | her biri response | ✅ |
| G7 | `Task<ActionResult<T>>` / async | | unwrap Task | ❓ |
| G8 | `ValueTask<T>` | | unwrap | ❓ |
| G9 | `Ok(obj)` / `NotFound()` gövde çıkarımı | ControllerResultReader | status+şema çıkarımı | ✅ |
| G10 | `CreatedAtAction` / `BadRequest(x)` | | 201/400 + şema | ⚠️ |
| G11 | Minimal `Results.Ok(x)` / `Results.NotFound()` | MinimalApiResultReader | status çıkarımı | ✅ |
| G12 | `TypedResults.Ok<T>` | | 200 + T | ✅ |
| G13 | `Results<Ok<T>, NotFound>` union | | üye başına response | ✅ |
| G14 | `.Produces<T>(200)` / `.Produces(404)` fluent | | response ekle | ✅ |
| G15 | `.ProducesProblem(400)` / `ProblemDetails` | | 400 + ProblemDetails şema | ❓ |
| G16 | `void` / `Task` dönüş | | 200/204 boş | ❓ |
| G17 | `IResult` (tipsiz minimal) | | default 200 | ⚠️ |
| G18 | `File(...)` / `PhysicalFile` | | binary/stream response | ❓ |
| G19 | `Redirect` / 3xx | | davranış? | ❓ |
| G20 | Birden çok return path farklı tip | `if...return A else return B` | oneOf? ilk mi? | ❓ |
| G21 | 204 NoContent (Delete) | | 204 gövdesiz | ✅ |

## H. İçerik müzakeresi (content types)

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| H1 | `[Produces("application/json")]` | response content_type | ⚠️ |
| H2 | Çoklu `[Produces]` | content_types listesi | ⚠️ |
| H3 | `[Consumes]` + `[Produces]` birlikte | ikisi de | ✅ (ContentNegotiationTests) |
| H4 | Global JSON opsiyonları (camelCase vb.) | property adları? | ❓ |

## I. Şema & DTO

| ID | Senaryo | Örnek | Beklenen | Durum |
| --- | --- | --- | --- | --- |
| I1 | `class` DTO → components/schemas + $ref | | dedup, $ref | ✅ |
| I2 | `record` DTO | `record User(long Id,string Name)` | positional props | ✅ |
| I3 | `struct` / `record struct` | | object schema | ❓ |
| I4 | Nullable property `string?` | | nullable | ✅ |
| I5 | `required` property | | required listesi | ✅ |
| I6 | Nested DTO (DTO içinde DTO) | | iç $ref | ⚠️ |
| I7 | Self-referential / cyclic tip | `Node{Node Next}` | sonsuz döngü yok, $ref | ❓ |
| I8 | `List<T>` / `T[]` / `IEnumerable<T>` | | array | ✅ |
| I9 | `Dictionary<K,V>` | | object + additionalProperties | ✅ |
| I10 | `Dictionary<int,V>` (string olmayan key) | | key **yoksayılır**, sessizce string-key obje | ⚠️ |
| I11 | Generic DTO `Paged<T>` | | somutlaştırılmış şema + isim | ⚠️ |
| I12 | İç içe generic `Paged<List<User>>` | | çözülür mü | ❓ |
| I13 | Primitive'ler: int/long/short/byte | | integer + format | ⚠️ |
| I14 | `decimal`/`double`/`float` | | number + format | ⚠️ |
| I15 | `DateTime`/`DateTimeOffset`/`DateOnly`/`TimeOnly` | | string + format | ❓ |
| I16 | `Guid` | | string uuid | ✅ |
| I17 | `Uri` | | string uri | ❓ |
| I18 | `TimeSpan` | | string / format? | ❓ |
| I19 | `object` / `dynamic` | | boş şema `{}` | ❓ |
| I20 | Tuple `(int,string)` / `ValueTuple` | | **kayıp:** struct sayılır → boş `{}` OBJECT | ✗ |
| I20b | Public **field** (property değil) | `public int X;` | **kayıp:** sadece property'ler okunur | ✗ |
| I20c | `IAsyncEnumerable<T>` dönüş/tip | | **BUG:** array değil, boş OBJECT'e düşer | ✗ |
| I20d | `object` / `dynamic` / `JsonElement`/`JsonNode` | | boş `{}` OBJECT (serbest form) | ⚠️ |
| I21 | `[JsonPropertyName]` yeniden adlandırma | | property adı değişir | ⚠️ |
| I22 | Newtonsoft `[JsonProperty]` | | property adı değişir | ⚠️ |
| I23 | `[JsonIgnore]` property | | şemadan çıkar | ⚠️ |
| I24 | Read-only / computed property | `=> X` | dahil mi? | ❓ |
| I25 | Static / const alanlar | | hariç | ❓ |
| I26 | Field (property değil) | public alan | dahil mi? | ❓ |
| I27 | Aynı isimde iki DTO (farklı namespace) | | isim çakışması dedup | ❓ |
| I28 | Çok derin nesting (10+ seviye) | | çökme yok | ❓ |

## J. Enum

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| J1 | Enum default (numeric) | integer + enum değerleri | ✅ |
| J2 | Global `JsonStringEnumConverter` | string + isimler | ✅ |
| J2b | Generic `JsonStringEnumConverter<T>` (.NET 8) | | **BUG:** isim eşleşmez → string'e çevrilmez | ✗ |
| J2c | `JsonStringEnumConverter` yorumda/testte geçiyor | | **BUG:** salt sözdizimsel tarama → tüm enum'lar string olur (false positive) | ✗ |
| J3 | `[JsonConverter(typeof(JsonStringEnumConverter))]` prop/tip | string | ✅ |
| J4 | `[Flags]` enum | davranış? | ❓ |
| J5 | Explicit değerli enum (`= 5`) | numeric değerler doğru | ❓ |
| J6 | Enum içinde `[EnumMember]`/`[JsonPropertyName]` | isim override | ❓ |
| J7 | Nullable enum `Status?` | nullable | ❓ |

## K. Inheritance & Polymorphism

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| K1 | Türetilmiş sınıf miras alınan property'leri içerir | inherited props inline | ✅ |
| K2 | `[JsonPolymorphic]`+`[JsonDerivedType]` | oneOf + discriminator + mapping | ✅ |
| K3 | Discriminator `$type` custom adı | doğru discriminator | ⚠️ |
| K4 | Abstract base + çok türev | oneOf tüm türevler | ⚠️ |
| K5 | `allOf` inheritance stili | davranış (inline vs allOf) | ❓ |
| K6 | Interface tipi property `IShape` | oneOf / object? | ❓ |
| K7 | Derin miras zinciri (3+ seviye) | tüm props toplanır | ❓ |

## L. Data annotations → constraints

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| L1 | `[Required]` | required listesi | ⚠️ |
| L1b | `[Required] string? x` (nullable + Required) | | **BUG:** required'lık yalnız nullability'den; `[Required]` DataAnnotation olarak uygulanmaz → required olmaz | ✗ |
| L2 | `[StringLength(120,MinimumLength=3)]` | min/maxLength | ✅ |
| L3 | `[MinLength]`/`[MaxLength]` | min/maxLength | ✅ |
| L4 | `[Range(1,100)]` (int) | minimum/maximum | ✅ |
| L5 | `[Range(0.01,1e6)]` (double) | number bounds | ✅ |
| L6 | `[RegularExpression]` | pattern | ✅ |
| L7 | `[EmailAddress]` | format email | ✅ |
| L8 | `[Url]` | format uri | ⚠️ |
| L9 | `[Phone]` | format/pattern | ⚠️ |
| L10 | `[DataType(DataType.Date)]` | format | ⚠️ |
| L11 | `[Range]` exclusive bound | exclusiveMin/Max | ❓ |
| L12 | `[Compare]`/`[CreditCard]` vb. | yoksayılır (çökme yok) | ❓ |
| L13 | Method param üzerinde annotation (`[Range]` query) | param constraint | ✅ |

## M. Auth & security

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| M1 | Controller `[Authorize]` | bearer JWT securityScheme | ✅ |
| M2 | `[AllowAnonymous]` override | auth yok (öncelikli) | ✅ |
| M3 | Method `[Authorize]` | endpoint güvenliği | ✅ |
| M4 | Minimal `.RequireAuthorization()` | bearer | ✅ |
| M5 | Minimal `.AllowAnonymous()` | auth yok | ✅ |
| M6 | Method-ref handler'da `[Authorize]` | method'tan okunur | ✅ |
| M7 | `[Authorize(Roles=...)]` / policy | scopes/roller? şema? | ❓ |
| M8 | `[Authorize(AuthenticationSchemes=...)]` | scheme adı | ❓ |
| M9 | API key auth (custom header) | apiKey scheme | ✗ |
| M10 | OAuth2 / OpenIdConnect | ilgili scheme | ✗ |
| M11 | Grup düzeyi `.RequireAuthorization()` (MapGroup) | tüm alt endpoint'ler | ❓ |
| M12 | Birden çok auth şeması aynı specte | dedup by id | ❓ |
| M13 | Auth şema id dedup (aynı bearer paylaşımı) | tek scheme | ✅ |

## N. Dokümantasyon (XML doc comments)

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| N1 | `<summary>` → operation summary | | ✅ |
| N2 | `<remarks>` → description | | ✅ |
| N3 | `<param name>` → parametre açıklaması | | ✅ |
| N4 | `<c>`, `<see>` gibi inline tag'ler | temizlenir/işlenir | ❓ |
| N5 | Çok satırlı / markdown remarks | korunur | ❓ |
| N6 | DTO property üzerinde XML doc | property description | ❓ |
| N7 | `<returns>` | response description | ❓ |
| N8 | `<response code="404">` | status açıklaması | ❓ |
| N9 | Method-ref handler'da XML doc | okunur | ✅ |
| N10 | Eksik/bozuk XML doc | çökme yok | ❓ |

## O. Tanılama, diagnostics & --strict

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| O1 | Parse edilemeyen endpoint → W-diagnostic | route düşmez, uyarı | ⚠️ |
| O2 | `--strict` + error severity | exit 1 | ✅ |
| O3 | `--strict` yokken error | çıktı yine üretilir | ✅ |
| O4 | 0 route bulundu | "0 routes", exit 1 | ✅ |
| O5 | Diagnostic kodları — sadece **W001/W002/W003** var, **E0xx yok** | W001=literal olmayan route path, W002=çözülemeyen handler, W003=workspace/solution yükleme | ⚠️ |
| O5b | MVC tarafı sessiz atlama | abstract controller, çözülemeyen action body | **hiç diagnostic yok** (sessiz) | ✗ |
| O6 | Kısmen parse edilebilen proje | parse edilenler + uyarılar | ❓ |
| O7 | Derlenmeyen C# (syntax hatası) | graceful, diagnostic | ❓ |
| O8 | Eksik referans/paket | davranış? | ❓ |

## P. Analyzer subprocess & bridge

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| P1 | Analyzer bulunamadı (build edilmemiş) | `AnalyzerNotFoundError`, exit 2 | ✅ |
| P2 | Analyzer çöktü (non-zero) | `AnalyzerCrashedError`, exit 1 | ⚠️ |
| P3 | Bozuk/parse edilemeyen JSON stdout | `AnalyzerOutputError`, exit 1 | ⚠️ |
| P4 | IR zod doğrulaması başarısız (drift) | hata, exit 1 | ⚠️ |
| P5 | Çok büyük stdout (binlerce route) | buffer taşmaz | ❓ |
| P6 | Analyzer takılması / uzun süre | 120s timeout → kill, exit 124 → `AnalyzerCrashedError` | ⚠️ |
| P7 | `dotnet` PATH'te yok (ENOENT) | **kaba hata:** tipsiz → "Unexpected error", exit 1 (dostça değil) | ✗ |
| P8 | `REFERENCE` şeması `refName`'siz | generator **hard throw** → CLI "Unexpected error" exit 1 | ⚠️ |

## Q. Çıktı formatı & determinizm

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| Q1 | Varsayılan YAML çıktı | geçerli YAML | ✅ |
| Q2 | `--json` | geçerli JSON | ✅ |
| Q3 | `-o dosya` | dizin oluşturur, yazar | ✅ |
| Q4 | stdout (o yok) | stdout'a yazar | ✅ |
| Q5 | `--title` / `--version-tag` override | info.title/version | ⚠️ |
| Q6 | Override yoksa csproj'dan title/version | projectInfo çıkarımı | ❓ |
| Q7 | Determinizm: aynı girdi → aynı çıktı | byte-identical (route/schema sırası); çoklu-proje seçiminde risk (A6b) | ❓ |
| Q8 | operationId çakışması dedup | benzersiz operationId | ✅ (e2e invariant) |
| Q9 | Duplicate parametre engellenir | benzersiz param | ✅ (e2e invariant) |
| Q10 | Çıktı OpenAPI 3.1 meta-şema geçerli | valid | ✅ (e2e) |

## R. Çoklu proje / solution

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| R1 | `.sln` içindeki her csproj analiz edilir | tüm route'lar | ⚠️ |
| R2 | DTO'lar bir kez hoisted (paylaşımlı) | tek schema, dedup | ⚠️ |
| R3 | İki projede aynı isimli DTO | çakışma yönetimi | ❓ |
| R4 | Web olmayan projeler (class lib) atlanır | route yok | ❓ |
| R5 | `.slnx` yeni format parse | çalışır | ❓ |
| R6 | Projeler arası tip referansı | çözülür mü | ❓ |
| R7 | Boş solution / hiç web projesi | 0 route, exit 1 | ❓ |

## S. Performans & ölçek

| ID | Senaryo | Beklenen | Durum |
| --- | --- | --- | --- |
| S1 | 100+ endpoint tek proje | makul süre, doğru sayı | ❓ |
| S2 | 500+ DTO | dedup, bellek | ❓ |
| S3 | Büyük solution (10+ proje) | tamamlanır | ❓ |
| S4 | Derin/geniş şema grafiği | çökme yok | ❓ |

## T. OpenAPI 3.1 geçerlilik invariant'ları (her canlı koşuda)

Her canlı testte çıktı üzerinde otomatik kontrol edilmesi gerekenler:

- [ ] OpenAPI 3.1 meta-şemasına göre **valid**.
- [ ] Tüm `operationId`'ler **benzersiz**.
- [ ] Bir operasyonda `{in,name}` bazında **duplicate parametre yok**.
- [ ] Her `$ref` `components/schemas` altında **çözümleniyor** (dangling ref yok).
- [ ] Path template'deki her `{param}` için bir path parametresi **var** (ve tersi).
- [ ] `securitySchemes`'e referans veren her `security` **tanımlı**.
- [ ] Nullable, 3.1 tarzı (`type: [..., "null"]`) emit ediliyor.
- [ ] Boş/`null` şema üretilmiyor (her schema geçerli bir kind taşıyor).

---

## U. Kaynak-doğrulanmış bulgular (canlı testte MUTLAKA kontrol et)

Aşağıdakiler koddan **doğrulanmış** davranışlardır (varsayım değil). Canlı testte
en yüksek getiri bunlarda; her biri "çökme yok + sessiz yanlış üretme yok" ekseninde
test edilmeli.

### U.1 — Kesin bug'lar (yanlış çıktı üretir)

| # | Bulgu | Etki | İlgili senaryo |
| --- | --- | --- | --- |
| U1 | `TypeClassifier.IsSimpleType` enum'ı **simple** saymıyor | `[FromQuery]`/route **enum** parametresi body'ye bağlanır | E15, D-enum |
| U2 | DI **concrete class** servisi (`AppDbContext`) interface değil → servis sayılmaz | body parametresi olarak sızar | E11b |
| U3 | `[Required]` DataAnnotation required'lık için **kullanılmıyor** (yalnız nullability) | `[Required] string? x` required olmaz | L1b |
| U4 | Public **field**'lar okunmuyor (yalnız property) | DTO alanları şemadan kaybolur | I20b |
| U5 | Tuple / `ValueTuple` / `IAsyncEnumerable<T>` → boş `{}` OBJECT | tip bilgisi kaybı | I20, I20c |
| U6 | Generic `JsonStringEnumConverter<T>` isim eşleşmiyor | enum string'e çevrilmez | J2b |
| U7 | `JsonStringEnumConverter` **salt sözdizimsel** taranıyor (yorum/test dâhil) | tüm enum'lar yanlışlıkla string olur | J2c |
| U8 | `[NonAction]` yoksayılıyor | Http attribute'lu ise yine route üretir | B15 |
| U9 | Non-string `Dictionary` key sessizce string-key'e indirgeniyor | yanlış key tipi | I10 |

### U.2 — Kesin boşluklar (desteklenmiyor; graceful olmalı)

| # | Bulgu | Beklenen canlı davranış | İlgili |
| --- | --- | --- | --- |
| U10 | Auth **yalnızca** `http/bearer/JWT` — apiKey/oauth2/oidc/mutualTLS, roller/policy/scope yok | çökme yok; bearer'a düşer | M7–M12 |
| U11 | Base/abstract controller'dan **miras action**'lar yürünmez | route eksik, çökme yok | B12 |
| U12 | Minimal API: `MapMethods`, `Map`, `MapControllers`, `[AsParameters]`, complex-`[FromQuery]` flatten, `WithOpenApi`/endpoint filter | eksik, çökme yok | C9–C13, E12, E18 |
| U13 | `object`/`JsonElement`/`JsonNode`/interface/struct → serbest-form boş `{}` | valid ama zayıf şema | I19, I20d |
| U14 | `[Range]` exclusive bound & .NET 8 doğrulama attribute'ları (`[Length]`, `[AllowedValues]`…) yok | constraint yok, çökme yok | L11–L12 |
| U15 | Return unwrap **4 seviye** ve sadece `Task/ValueTask/ActionResult<T>` | diğer awaitable'lar çözülmez | G7–G8 |
| U16 | XML doc: `<response code>` okunmuyor; DTO property doc'ları okunmuyor | eksik açıklama | N6, N8 |

### U.3 — Kırılganlık / robustluk noktaları

| # | Bulgu | Canlı testte kontrol |
| --- | --- | --- |
| U17 | Çoklu csproj/sln → **first-wins, non-deterministik** (dosya sistemi sırası) | aynı repoda tekrar çalıştır, aynı proje mi seçiliyor | A6b, Q7 |
| U18 | `dotnet` PATH'te yoksa → **tipsiz** "Unexpected error" (dostça `AnalyzerNotFoundError` değil) | anlaşılır mesaj mı | P7 |
| U19 | Analyzer 120s'de timeout → kill → exit 124 → `AnalyzerCrashedError` | büyük projede tetikleniyor mu | P6 |
| U20 | `REFERENCE` şeması `refName`'siz → generator **hard throw** → CLI "Unexpected error" | drift durumunda çökme | P8 |
| U21 | Aynı path+method iki route → generator'da **son yazan kazanır** (sessiz) | çakışma sessizce mi kayboluyor | C17, Q |
| U22 | Aynı simple-name farklı namespace DTO → `Order`/`Order2` (namespace yok, sıraya bağlı) | isim kararlılığı | I27, R3 |
| U23 | `--strict` mesajı hata **sayısı yerine toplam** diagnostic sayısını basıyor (kozmetik) | mesaj doğruluğu | O2 |
| U24 | Controller + Minimal API aynı route'u tanımlarsa **dedup yok** → iki kez emit | çift operation | C17 |

### U.4 — Diagnostic envanteri (tam liste)

| Kod | Anlamı | Tetikleyici |
| --- | --- | --- |
| **W001** `DynamicRoutePath` | route path literal değil | `MapX(nonLiteral, ...)` → route atlanır |
| **W002** `UnresolvedHandler` | method-ref handler çözülemedi | route emit edilir, param/response eksik olabilir |
| **W003** `WorkspaceLoad` | workspace/solution yükleme sorunu | `.sln`/`.slnx` açılamadı → csproj taramasına düşüş |
| **E0xx** | — | **tanımlı değil**; hard failure yalnız stderr + non-zero exit |

---

## Canlı test için önerilen gerçek projeler

Kapsamı gerçekçi zorlamak için farklı stiller:

1. **Küçük Controllers** — klasik `[ApiController]` CRUD (ör. eShopOnWeb tarzı).
2. **Küçük Minimal API** — `MapGroup` + `TypedResults` yoğun.
3. **Karışık** — aynı projede Controllers + Minimal API.
4. **Büyük gerçek dünya** — çok projeli `.sln`, generic'ler, polymorphism, auth.
5. **Zorlayıcı/uç** — R/S bölümündeki desteklenmeyen yapıları içeren, "çökmemeli" testi için.

## Öncelik sırası (canlı testte ilk bakılacaklar)

1. **U.1 kesin bug'lar (U1–U9)** — yanlış çıktı üretiyorlar; en yüksek öncelik.
2. **U.3 robustluk (U17–U24)** — çökme/sessiz-kayıp/non-determinizm riski.
3. **U.2 kesin boşluklar (U10–U16)** — "graceful mı" kontrolü (çökmeden atlamalı).
4. **❓ dönüş tipi çıkarımı** (G7–G20) — gerçek kod tabanlarında en çeşitli alan.
5. **❓ şema/tip kapsama** (I13–I19, J4–J7, K5–K7) — primitive/format doğruluğu.
6. **❓ solution** (R1–R7) — çoklu proje canlıda ilk kez zorlanacak.
