# E2E fixtures

Her alt dizin gerçek bir ASP.NET Core projesi (veya `.sln`); `pnpm test:e2e` bunları
analyzer → IR → generator hattından geçirir ve üç kapıdan kontrol eder:

1. **Golden** — `expected.openapi.yaml` ile byte-byte eşleşme.
2. **OpenAPI 3.1 meta-şema** geçerliliği.
3. **Invariant'lar** — `checkOpenApiInvariants` (`docs/test-scenarios.md` §T).

CLI sözleşmesi (`apps/cli/test/cli.e2e.test.ts`) aynı fixture'ları gerçek `bin.js` ile koşturur.

| Fixture | Kapsadığı senaryolar |
| --- | --- |
| `controllers-basic` | B1, B2, D1, E4, F1, G1, G2, G21, I1, I4, I5 |
| `controllers-rich` | B9, G3, G4, G6, L1–L7, L13, M1, M2, N1–N3 |
| `controllers-route-params` | B4, D2–D5, E2, E3, E8, E9 |
| `controllers-features` | E3, E12, E15, G36, I3, I29, J2, K2/K3/K8, L3b/L15, M19, B14, B32 |
| `solution-multi-project` | A3, R1, R2/R6, Q7 (proje sırası) |
| `diagnostics-open-generic` | B13 (W004), O2/O3 (`--strict` uyarıyla geçer) |
| `diagnostics-multi-csproj` | A6b (W007), A14 notu |
| `diagnostics-load-failure` | E001 → exit 1 (golden yok; yalnız CLI testi) |

## Yeni fixture eklemek

1. `fixtures/dotnet/<tür>-<konu>/` altında `net8.0` bir proje oluştur (`Microsoft.NET.Sdk.Web`;
   kütüphane için `Microsoft.NET.Sdk`). **NuGet `PackageReference` ekleme** — restore ağdan
   bağımsız kalmalı; üçüncü parti attribute'ları stub'la (bkz. `controllers-features/Versioning`),
   analyzer attribute'ları kısa adla eşler.
2. Tek konuya odaklan; her controller'ın başına hangi katalog satırlarını kanıtladığını yaz.
3. Dosya ve dizin adlarını ASCII ve büyük/küçük harf düzeni tutarlı seç: CLI (`localeCompare`)
   ile analyzer (`Ordinal`) aynı adayı seçmeli (A14).
4. `dotnet build <csproj>` ile derlendiğini gör, `pnpm restore:fixtures` çalıştır.
5. `pnpm test:e2e` → `expected.openapi.yaml` üretilir. **Dosyayı oku**: her beklenen satırı
   (path, parametre, şema, constraint) kontrol et. Beklenmeyen çıktı analyzer bulgusudur;
   golden'ı "düzeltme", bulguyu PR'da raporla.
6. Çıktı üretmemesi gereken bir fixture'ı `apps/cli/test/pipeline.e2e.test.ts` içindeki
   `FAILURE_FIXTURES` setine ekle ve sözleşmesini `cli.e2e.test.ts`'e yaz.

## Golden'larda dondurulmuş bilinen bulgular

Golden'lar **mevcut** davranışı kaydeder. Aşağıdaki satırlar bilinerek şüpheli/yanlış olarak
dondurulmuştur; bu işte düzeltilmedi (analyzer/generator düzeltmesi ayrı PR). Düzeltme
geldiğinde golden diff'i PR'da görünür ve bu tablo güncellenir.

| # | Yer | Bulgu |
| --- | --- | --- |
| F1 | `controllers-features` → `GET /api/products` parametreleri | `[AsParameters]` ile açılan query adlarına global JSON naming policy uygulanmış (`page_size`); MVC query binding property adını (büyük/küçük harf duyarsız) kullanır — üretilen istemci `page_size` gönderir, sunucu bağlamaz |
| F2 | aynı | initializer'lı property'ler (`Page = 1`) `required: true` çıkıyor; E9'daki "default ⇒ opsiyonel" kuralı property'lere uygulanmıyor |
| F3 | `components.schemas.ProductQuery` | flatten edilen tip, hiçbir yerden referans verilmediği halde hoist edilmiş (yetim şema) |
| F4 | `/api/v1.0/Reports` (`Reports_List`) vs `/api/v2.0/Reports` (`List_2`) | versiyon fan-out'unda operationId dedup'ı tutarsız ad üretiyor (generator `uniqueOperationId`) |
| F5 | `controllers-features` → `[AsParameters]` | Minimal API attribute'u; MVC bunu yok sayar ve `[ApiController]` complex parametreyi `[FromBody]` olarak çıkarır — controller'larda flatten davranışı (E12) yeniden değerlendirilmeli |

## Golden güncelleme

Analyzer/generator davranışını bilerek değiştirdiysen:

```bash
pnpm test:e2e -u
git diff fixtures/   # her satırı gözden geçir; PR açıklamasında değişikliği gerekçelendir
```

`CI` ortam değişkeni set olduğunda vitest yeni snapshot yazmaz; golden'lar commit edilmek zorundadır.
