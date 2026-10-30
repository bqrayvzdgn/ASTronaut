using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

public static class TypeClassifier
{
    private static readonly SymbolDisplayFormat Fq = SymbolDisplayFormat.FullyQualifiedFormat;

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
        if (IsSimpleType(type)) return false;
        if (type.TypeKind == TypeKind.Interface) return true;

        if (type is INamedTypeSymbol named2)
        {
            if (DerivesFromDbContext(named2)) return true;

            return HasNoBindableSurface(named2);
        }
        return false;
    }

    private static bool DerivesFromDbContext(INamedTypeSymbol type)
    {
        for (var t = type.BaseType; t is not null; t = t.BaseType)
        {
            if (t.ToDisplayString(Fq) == "global::Microsoft.EntityFrameworkCore.DbContext")
            {
                return true;
            }
        }
        return false;
    }

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

    public static bool IsSimpleType(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol nt
            && nt.IsGenericType
            && nt.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T
            && nt.TypeArguments.Length == 1)
        {
            type = nt.TypeArguments[0];
        }
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
