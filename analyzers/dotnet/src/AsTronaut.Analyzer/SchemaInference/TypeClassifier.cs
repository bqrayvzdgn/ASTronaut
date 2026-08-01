using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Parameter/type classification used by the controller walker. Kept as a single
// shared source (rather than inlined) so parameter/DI-service rules — e.g. that
// ILogger<T> and DI services are not part of the HTTP surface — live in one place.
public static class TypeClassifier
{
    private static readonly SymbolDisplayFormat Fq = SymbolDisplayFormat.FullyQualifiedFormat;

    // A framework/DI-provided parameter that is not part of the HTTP surface
    // (skipped from path/query/body). Beyond the well-known request-context
    // types, injected dependencies are almost always interfaces (IMediator,
    // IUserService, IOptions<T>). Interfaces that are actually request data —
    // IFormFile and collection interfaces (IEnumerable<T>, IList<T>) — are
    // excluded. Abstract classes are intentionally NOT treated as services: a
    // [JsonPolymorphic] abstract base is a valid request/response body.
    public static bool IsServiceType(ITypeSymbol type)
    {
        var full = type.ToDisplayString(Fq);
        if (full is "global::System.Threading.CancellationToken"
            or "global::Microsoft.AspNetCore.Http.HttpContext"
            or "global::Microsoft.AspNetCore.Http.HttpRequest"
            or "global::Microsoft.AspNetCore.Http.HttpResponse"
            or "global::System.Security.Claims.ClaimsPrincipal"
            or "global::Microsoft.Extensions.Logging.ILogger"
            or "global::Microsoft.AspNetCore.Mvc.ModelBinding.ModelStateDictionary")
        {
            return true;
        }

        if (type is INamedTypeSymbol { IsGenericType: true } generic)
        {
            var def = generic.ConstructedFrom?.ToDisplayString(Fq);
            if (def == "global::Microsoft.Extensions.Logging.ILogger<TCategoryName>") return true;
        }

        if (IsFormFileType(type)) return false;
        if (IsEnumerable(type)) return false;
        if (type.TypeKind == TypeKind.Interface) return true;

        // The DI container is not visible to static analysis, so we cannot know
        // what was registered. Conservative heuristic: a concrete (non-abstract)
        // class that is not a record and exposes no bindable surface (no public
        // writable instance property) is an opaque service/marker (AppDbContext,
        // a hand-written service). A DTO always has at least one settable/init
        // property or is a positional record, so real bodies are never flipped.
        if (type is INamedTypeSymbol named2) return HasNoBindableSurface(named2);
        return false;
    }

    // True for a concrete, non-record class with no public writable instance
    // property — i.e. nothing a model binder could populate. Used only as the
    // last resort in IsServiceType (see the DI-invisibility note there).
    private static bool HasNoBindableSurface(INamedTypeSymbol type)
    {
        if (type.TypeKind != TypeKind.Class) return false;
        if (type.IsAbstract) return false;
        if (type.IsRecord) return false;
        foreach (var member in type.GetMembers())
        {
            if (member is IPropertySymbol { IsStatic: false, DeclaredAccessibility: Accessibility.Public } prop
                && prop.SetMethod is { DeclaredAccessibility: Accessibility.Public })
            {
                return false;
            }
        }
        return true;
    }

    // A scalar that binds from the route/query as a single value.
    public static bool IsSimpleType(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol nt
            && nt.IsGenericType
            && nt.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T
            && nt.TypeArguments.Length == 1)
        {
            type = nt.TypeArguments[0];
        }
        // Enums bind from route/query as a single value (their underlying scalar
        // or member name). Checked after the Nullable<T> unwrap so Nullable<MyEnum>
        // is handled too.
        if (type.TypeKind == TypeKind.Enum) return true;
        switch (type.SpecialType)
        {
            case SpecialType.System_Boolean:
            case SpecialType.System_Char:
            case SpecialType.System_SByte:
            case SpecialType.System_Byte:
            case SpecialType.System_Int16:
            case SpecialType.System_UInt16:
            case SpecialType.System_Int32:
            case SpecialType.System_UInt32:
            case SpecialType.System_Int64:
            case SpecialType.System_UInt64:
            case SpecialType.System_Single:
            case SpecialType.System_Double:
            case SpecialType.System_Decimal:
            case SpecialType.System_String:
                return true;
        }
        var full = type.ToDisplayString(Fq);
        return full is "global::System.Guid"
            or "global::System.DateTime"
            or "global::System.DateTimeOffset"
            or "global::System.DateOnly"
            or "global::System.TimeOnly"
            or "global::System.TimeSpan"
            or "global::System.Uri";
    }

    // IFormFile, IFormFileCollection, or a generic collection of IFormFile.
    public static bool IsFormFileType(ITypeSymbol type)
    {
        if (type.ToDisplayString(Fq)
                .StartsWith("global::Microsoft.AspNetCore.Http.IFormFile", StringComparison.Ordinal))
        {
            return true;
        }
        if (type is INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } g)
        {
            return g.TypeArguments[0].ToDisplayString(Fq)
                == "global::Microsoft.AspNetCore.Http.IFormFile";
        }
        return false;
    }

    public static bool IsNullable(ITypeSymbol type)
    {
        if (type.NullableAnnotation == NullableAnnotation.Annotated && type.IsReferenceType) return true;
        if (type is INamedTypeSymbol named
            && named.IsGenericType
            && named.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T) return true;
        return false;
    }

    private static bool IsEnumerable(ITypeSymbol type)
    {
        if (type.SpecialType == SpecialType.System_String) return false;
        if (type is IArrayTypeSymbol) return true;
        if (type.OriginalDefinition.SpecialType == SpecialType.System_Collections_IEnumerable) return true;
        foreach (var iface in type.AllInterfaces)
        {
            if (iface.SpecialType == SpecialType.System_Collections_IEnumerable) return true;
        }
        return false;
    }
}
