# E2E Golden Suite — Tasarım

> Tarih: 2026-09-22 · Durum: onaylı (kararlar delege edildi)
>
> "Projeyi uçtan uca çalışır hale getirme" dizisinin 2. alt projesi:
> **1** yerel spike ✅ → **2** E2E paketi (bu belge) → **4** gerçek projelerde canlı E2E → **3** npx son-kullanıcı akışı.

## 1. Amaç ve başarı ölçütü

Bugünkü e2e (`apps/cli/test/pipeline.e2e.test.ts`) üç fixture'ı analyzer'dan geçirip yalnız
OpenAPI 3.1 meta-şema geçerliliği + operationId/parametre tekilliğini kontrol ediyor. Analyzer'daki
bir davranış değişikliği, çıktı "geçerli" kaldığı sürece hiçbir testi kırmıyor; CLI'nin kendisi
(exit kodları, opsiyonlar, stdout/stderr ayrımı) hiç koşmuyor; `.sln`, Grup 1 düzeltmeleri ve
tanılama yolları gerçek MSBuild derlemesiyle test edilmiyor.

Bu iş bittiğinde:

1. Her fixture için **gerçek CLI'nin** ürettiği OpenAPI, repoya commit edilmiş bir
   `expected.openapi.yaml` ile birebir eşleşir; her semantik değişiklik PR diff'inde görünür.
2. Katalogdaki (`docs/test-scenarios.md` §T) invariant'lar yeniden kullanılabilir bir modülle
   otomatik kontrol edilir.
3. CLI sözleşmesi (exit 0/1/2, `--json` stdout saflığı, `-o`, `--strict`, `--title`,
   `--version-tag`, analyzer-yok, 0-route) e2e'de koşar.
4. `.sln` çoklu proje, Grup 1 özellikleri (E3, E12, G36, B32, I3, I29, L3b/L15, M19) ve tanılama
   yolları (W004, W007, E001) gerçek C# → MSBuild → analyzer → generator hattında koşar.
5. CI'da Linux **ve** Windows'ta yeşil; `pnpm test:e2e` toplamı ≈ 60 sn altında.

## 2. Kapsam dışı (bilinçli)

- O9: E001'in `--strict` yolunda CLI'ya ulaşamaması (bridge non-zero exit'te stdout'u okumuyor).
  Test yalnız kararlı sözleşmeyi (exit 1) sabitler; düzeltme ayrı iş.
- CLI `--timeout` seçeneği (canlı test için gerekecek; alt proje 4'te).
- A14: `detect.ts` ↔ `ProjectLoader` çift çözümleme ve karşılaştırıcı farkı.
- Yeni analyzer özellikleri (Grup 2/3). Golden üretirken görülen şüpheli çıktılar **düzeltilmez,
  raporlanır**.

## 3. Mimari

```
fixtures/dotnet/<fixture>/          ──┐
  *.csproj | *.sln, Controllers/…     │  pipeline.e2e (süreç içi) · cli.e2e (apps/cli/dist/bin.js alt süreci)
  expected.openapi.yaml  ◀── golden ──┘         │
                                                ▼
                     detect → projectInfo → runAnalyzer (dotnet exec, MSBuild) → parseIR → toOpenApi → toYaml
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    ▼                           ▼                           ▼
        toMatchFileSnapshot(golden)   Validator (3.1 meta-şema)   checkOpenApiInvariants(doc)
```

| Bileşen | Yol | Durum |
| --- | --- | --- |
| Invariant modülü | `packages/generator/src/invariants.ts` (+ `index.ts` export) | yeni |
| Invariant unit testleri | `packages/generator/test/invariants.test.ts` | yeni |
| Golden pipeline testi | `apps/cli/test/pipeline.e2e.test.ts` | yeniden yazılır |
| CLI sözleşme testi | `apps/cli/test/cli.e2e.test.ts` | yeni |
| CLI çalıştırma yardımcısı | `apps/cli/test/support/runCli.ts` | yeni |
| Fixture'lar + golden'lar | `fixtures/dotnet/*` (+ `expected.openapi.yaml`, `fixtures/dotnet/README.md`) | 5 yeni fixture, 7 golden (3 mevcut + 4 yeni; `diagnostics-load-failure` golden'sız) |
| Determinizm | `ControllerWalker.Walk`, `ProjectLoader.OpenSolutionProjectsAsync` (+ unit test) | küçük ürün değişikliği |
| Fixture restore | `scripts/restore-fixtures.sh` + `.ps1`, `pnpm restore:fixtures` | yeni |
| CI | `.github/workflows/ci.yml` e2e job: restore script, `ubuntu-latest` + `windows-latest` | değişir |
| Docs | `README.md`, `docs/test-scenarios.md` | güncellenir |

Yaklaşım seçimi: invariant'lar generator paketinde yaşar (saf fonksiyon, bağımlılıksız), çünkü
üreticinin kendi çıktısı için verdiği garantilerin denetimidir; canlı test (alt proje 4) ve
ileride olası bir CLI `--check` aynı modülü kullanır. Ayrı bir harness paketi (YAGNI) ve
"her şey test klasöründe" (yeniden kullanım yok) seçenekleri elendi.

## 4. Golden mekanizması

- Golden = `toYaml(toOpenApi(...))` çıktısı, byte-byte. Pipeline testi `analyzeCommand`'ın adımlarını
  (detect → projectInfo → runAnalyzer → toOpenApi → toYaml) **süreç içinde** koşturur: IR/zod hataları
  doğrudan görünür ve `apps/cli`'ye YAML ayrıştırıcı bağımlılığı eklenmez. CLI sürecinin aynı golden'ı
  ürettiği `cli.e2e` ile kanıtlanır (basic: stdout ve `-o`; `--json` çıktısı `toYaml` ile golden'a
  geri dönüştürülerek; W004/W007 fixture'ları `-o` ile). Karşılaştırmadan önce `\r\n` → `\n`
  normalize edilir (`.gitattributes` zaten `eol=lf`; bu yalnız ek güvence).
- Vitest `await expect(text).toMatchFileSnapshot(path)`; güncelleme `vitest -u` ile
  (`pnpm test:e2e -u`; pnpm'in argüman geçirme biçimi uygulamada doğrulanıp README'ye yazılır).
  `CI` ortam değişkeni varken vitest yeni snapshot yazmaz → golden commit edilmek zorundadır.
- Golden testi yalnız `expected.openapi.yaml` içeren fixture dizinlerini gezer. Golden'ı olmayan
  fixture (`diagnostics-load-failure`) yalnız CLI sözleşme testinde adıyla kullanılır.
- Golden'lar **üretilip incelenir**: ilk üretimde her golden, fixture'ın hedeflediği katalog
  satırlarına göre elle okunur; beklenmeyen çıktı fixture'a not düşülür ve raporlanır (analyzer
  düzeltmesi bu işin kapsamında değildir).

## 5. Fixture'lar

Mevcut `controllers-basic`, `controllers-rich`, `controllers-route-params` değişmez; golden alır.

| Fixture | İçerik | Kanıtladığı |
| --- | --- | --- |
| `solution-multi-project` | Klasik `MultiProject.sln` → `Contracts` (classlib, `Customer` DTO), `Orders.Api` ve `Billing.Api` (her biri `Customer` döndüren bir controller + kendi DTO'su; ikisi de `Contracts`'a ProjectReference) | `.sln` yükleme, proje-arası tip referansı, `Customer`'ın **bir kez** hoist edilmesi (R2/R6), proje sırası determinizmi, solution başlığı (`MultiProject`, `0.0.0`) |
| `controllers-features` | Tek web projesi, **üç ayrı** controller dosyası + `Program.cs`'de `AddJsonOptions` (`SnakeCaseLower` + `JsonStringEnumConverter`). `ProductsController`: `[AsParameters]` (E12), `[FromHeader(Name="X-Tenant-Id")]` ve `[FromQuery(Name="page_size")]` (E3), enum query param (E15/J2), `[ProducesResponseType(200)]` + `return Ok(dto)` (G36), `record struct` property (I3), `[MaxLength]` koleksiyon vs string (L3b/L15). `ShapesController`: `[JsonPolymorphic]`/`[JsonDerivedType]` (K2/K8), `[Authorize(AuthenticationSchemes = "OAuth2")]` (M19). `ReportsController`: `[ApiVersion("1.0")][ApiVersion("2.0")]` + `[MapToApiVersion("2.0")]` (B14/B32), attribute'lar fixture içi `Asp.Versioning` stub'ları | Grup 1'in tamamı + snake_case (I29) + string enum gerçek derlemede; çok dosyalı olduğu için tree sırası determinizmi |
| `diagnostics-open-generic` | Somut `ItemsController` + `GenericController<T> : ControllerBase` (`[HttpGet]` taşıyan) | stderr'de `W004`, exit 0, golden'da yalnız somut route'lar |
| `diagnostics-multi-csproj` | `Alpha/Alpha.csproj` + `Beta/Beta.csproj` (her biri kendi controller'ı ile), `.sln` yok | CLI "Multiple .csproj files found" uyarısı + analyzer `W007`, Ordinal-first seçim (`Alpha`), exit 0, golden = Alpha |
| `diagnostics-load-failure` | Yalnız `Broken.sln` (var olmayan `Missing/Missing.csproj`'a referans), csproj yok | E001 → exit 1, stdout boş, stderr dolu; golden yok |

Fixture yazım kuralları (`fixtures/dotnet/README.md`'ye girer):

- `net8.0`, `Microsoft.NET.Sdk.Web` (classlib için `Microsoft.NET.Sdk`), **NuGet `PackageReference` yok**
  (restore ağdan bağımsız kalır; üçüncü parti attribute'lar stub'lanır — analyzer kısa ada bakar).
- Route'u olan her fixture `expected.openapi.yaml` taşır; golden `pnpm test:e2e -u` ile üretilir
  ve PR'da incelenir.
- Dosya/dizin adları `Ordinal` ve `localeCompare` sıralamalarının aynı sonucu vereceği şekilde
  seçilir (A14 farkına takılmamak için: aynı büyük/küçük harf düzeni, ASCII).
- Bir fixture tek konuya odaklanır; ad `<tür>-<konu>`.

## 6. Invariant modülü

```ts
// packages/generator/src/invariants.ts
export type InvariantRule =
  | "unique-operation-ids"        // T2
  | "unique-parameters"           // T3  {in,name} — path-item + operation parametreleri birlikte
  | "resolvable-refs"             // T4  her $ref (schema, discriminator.mapping) components.schemas'ta
  | "path-params-match-template"  // T5  {param} ⇔ in:path parametresi (iki yönlü), required:true
  | "security-schemes-defined"    // T6  security anahtarı securitySchemes'te; oauth2→flows, oidc→openIdConnectUrl
  | "nullable-3-1-style"          // T7  hiçbir şemada 3.0 kalıntısı `nullable` anahtarı yok
  | "no-empty-schema";            // T8  şema konumunda `{}` veya null yok

export interface InvariantViolation { rule: InvariantRule; path: string; message: string }
export function checkOpenApiInvariants(doc: OpenApiDocument): InvariantViolation[];
```

- Saf fonksiyon, bağımlılık yok; meta-şema geçerliliği (T1) e2e testinde
  `@seriousme/openapi-schema-validator` ile ayrı kalır (generator'a bağımlılık eklenmez).
- Şema gezintisi **tipli konumlar** üzerinden yapılır (`components.schemas.*`, `parameters[].schema`,
  `headers.*.schema`, `content.*.schema` ve içlerinde `properties.*`, `items`, `oneOf/anyOf/allOf[]`,
  nesne biçimli `additionalProperties`); `example`/`default` değerleri şema sayılmaz.
- `path`: insan-okur konum (`paths./users/{id}.get.parameters[1]`), hata mesajı fixture adıyla birlikte
  e2e'de gösterilir.
- Unit testleri: her kural için (a) minimal geçerli belge → boş liste, (b) tek ihlalli belge → yalnız
  o kural (`it.each`). Ek olarak generator'ın mevcut IR fixture'larından üretilen belgeler → boş liste.

## 7. CLI sözleşme testleri

Yardımcı: `runCli(args, { env?, cwd? })` → `execFile(process.execPath, [bin, ...args])`, non-zero
exit'te fırlatmaz, `{ code, stdout, stderr }` döner; `bin = apps/cli/dist/bin.js`. Dist yoksa test
açık mesajla **başarısız** olur ("run `pnpm build`"); analyzer yoksa suite bugünkü gibi skip edilir.

| # | Komut | Beklenti |
| --- | --- | --- |
| 1 | `analyze <basic> -o "<tmp>/nested dir/spec.yaml"` | exit 0, iç içe dizin (boşluklu) oluşur, dosya === golden, stdout boş |
| 2 | `analyze <basic>` (stdout) | exit 0, stdout === golden metni (saflık kanıtı) |
| 3 | `analyze <basic> --json` | exit 0, stdout JSON parse edilir; `toYaml(JSON.parse(stdout))` === golden |
| 3b | `analyze <basic> --json -o <tmp>/spec.json` | exit 0, dosya JSON; `toYaml(JSON.parse(file))` === golden |
| 4 | `analyze <basic> --title X --version-tag 9.9.9` | `info.title`/`info.version` override |
| 5 | `analyze ./does-not-exist` | exit 1, stderr "No supported project" |
| 6 | `ASTRONAUT_DOTNET_ANALYZER=<yok>` ile | exit 2, stderr analyzer bulunamadı |
| 7 | `analyze <diagnostics-open-generic>` | exit 0, stderr `W004` içerir |
| 8 | `analyze <diagnostics-open-generic> --strict` | exit 0 (uyarı strict'i düşürmez) |
| 9 | `analyze <diagnostics-multi-csproj>` | exit 0, stderr `W007` + "Multiple .csproj files found", çıktı golden'a eşit |
| 10 | `analyze <diagnostics-load-failure>` | exit 1, stdout boş, stderr dolu |
| 11 | `analyze <solution-multi-project>/Contracts/Contracts.csproj` | exit 1, stderr "0 routes" (yeni fixture gerekmez) |

Analyzer gerektiren durumlar en hızlı fixture (`controllers-basic`) üzerinde koşar.

## 8. Determinizm değişiklikleri (analyzer)

1. `ControllerWalker.Walk`: `_compilation.SyntaxTrees` → `FilePath` `StringComparer.Ordinal` sırası;
   dosya içi (kaynak) sıra korunur. Unit test: iki tree ters sırada verilir, route'lar yol sırasında çıkar.
2. `ProjectLoader.OpenSolutionProjectsAsync`: `solution.Projects` → `FilePath` Ordinal sırası.
   Kanıt: `solution-multi-project` golden'ı (MSBuild in-memory test edilemez).

Etki: çok dosyalı/çok projeli çıktıda route ve `components/schemas` sırası (dolayısıyla çakışmada
"bare" ad ataması) OS ve dosya sistemi sırasından bağımsız olur → katalog Q7 ✅.

## 9. CI ve script'ler

- `scripts/restore-fixtures.sh` (+ `.ps1`): `fixtures/dotnet` altındaki her `*.csproj` için
  `dotnet restore` (iç içe dizinler dâhil; `.sln` ayrıca restore gerektirmez). `package.json`:
  `"restore:fixtures": "bash scripts/restore-fixtures.sh"`.
- `ci.yml` e2e job: `strategy.matrix.os: [ubuntu-latest, windows-latest]`, `runs-on: ${{ matrix.os }}`,
  `defaults.run.shell: bash`; restore adımı script'i çağırır. Gerekçe: geliştirme Windows'ta, CI
  Linux'ta; golden'ların OS'ten bağımsızlığı bu paketin ana riski.
- Node/dotnet kurulum adımları aynı kalır.

## 10. Dokümantasyon

- `README.md` › Development: `pnpm restore:fixtures` adımı (bugün eksik), golden güncelleme komutu,
  e2e'nin ne doğruladığı.
- `fixtures/dotnet/README.md`: fixture ekleme adımları, yazım kuralları, golden inceleme disiplini.
- `docs/test-scenarios.md`: "Test seviyeleri" (e2e = golden + meta-şema + invariant), §T maddeleri
  "otomatik (e2e)" notu, Q7 ✅, e2e fixture'ıyla kapsanan satırlara `(e2e)` işareti.

## 11. Doğrulama ve teslim

- TDD: invariant kuralları ve walker sıralaması önce kırmızı test; e2e testleri golden'lar
  üretilmeden önce yazılır (kırmızı), `-u` ile golden üretilir, her golden elle incelenir (yeşil).
- Yerel doğrulama: `pnpm lint`, `pnpm build`, `pnpm test`, `dotnet test … -c Release`,
  `pnpm restore:fixtures`, `pnpm test:e2e`. Ardından CI (Linux + Windows).
- Branch: `feat/e2e-golden-suite`; PR açıklaması bu belgeye ve katalog satırlarına atıf verir.

## 12. Riskler ve uygulamada doğrulanacaklar

- **E001 tetikleyicisi:** "eksik projeye referans veren `.sln`"in her ortamda exit 1 verdiği
  uygulamada doğrulanır; vermezse alternatif tetikleyici (geçersiz XML'li tek `.csproj`) denenir.
- **`toMatchFileSnapshot` + pnpm arg geçirme:** `pnpm test:e2e -u` biçimi doğrulanır.
- **Windows runner süresi:** MSBuild ilk yükleme Linux'tan yavaş olabilir; `testTimeout` 180 sn yeterli.
- **Golden inceleme disiplini:** `-u` ile körlemesine güncelleme riskine karşı README'de açık kural.
