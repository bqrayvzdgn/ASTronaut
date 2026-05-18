using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Maps a Roslyn ITypeSymbol to an IR Schema. Handles primitives, well-known
// .NET types, nullables (Nullable<T> + C# 8 NRT), arrays/collections, and
// custom classes (hoisted into SharedSchemas via SchemaContext).
public sealed class TypeToSchema
{
    private readonly SchemaContext _ctx;

    public TypeToSchema(SchemaContext ctx)
    {
        _ctx = ctx;
    }

    public Schema Map(ITypeSymbol type)
    {
        var nullableFromNRT = type.NullableAnnotation == NullableAnnotation.Annotated
                              && type.IsReferenceType;
        var (inner, wrappedNullable) = UnwrapNullable(type);
        var nullable = nullableFromNRT || wrappedNullable;

        var schema = MapInner(inner);
        if (nullable && schema.Nullable != true)
        {
            schema = schema with { Nullable = true };
        }
        return schema;
    }

    private static (ITypeSymbol Inner, bool Nullable) UnwrapNullable(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol named
            && named.IsGenericType
            && named.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T
            && named.TypeArguments.Length == 1)
        {
            return (named.TypeArguments[0], true);
        }
        return (type, false);
    }

    private Schema MapInner(ITypeSymbol type)
    {
        // Well-known primitive special types.
        switch (type.SpecialType)
        {
            case SpecialType.System_String:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string" };
            case SpecialType.System_Boolean:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "boolean" };
            case SpecialType.System_Byte:
            case SpecialType.System_SByte:
            case SpecialType.System_Int16:
            case SpecialType.System_UInt16:
            case SpecialType.System_Int32:
            case SpecialType.System_UInt32:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "integer", Format = "int32" };
            case SpecialType.System_Int64:
            case SpecialType.System_UInt64:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "integer", Format = "int64" };
            case SpecialType.System_Single:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "number", Format = "float" };
            case SpecialType.System_Double:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "number", Format = "double" };
            case SpecialType.System_Decimal:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "number", Format = "decimal" };
            case SpecialType.System_Char:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string" };
            case SpecialType.System_Object:
                return new Schema { Kind = "OBJECT" };
            case SpecialType.System_Void:
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "null" };
        }

        // Well-known reference types by name.
        var fullName = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        switch (fullName)
        {
            case "global::System.Guid":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "uuid" };
            case "global::System.DateTime":
            case "global::System.DateTimeOffset":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "date-time" };
            case "global::System.DateOnly":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "date" };
            case "global::System.TimeOnly":
            case "global::System.TimeSpan":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "time" };
            case "global::System.Uri":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "uri" };
        }

        // Enums → string with enumValues (names).
        if (type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol enumType)
        {
            var names = enumType.GetMembers().OfType<IFieldSymbol>()
                .Where(f => f.IsConst).Select(f => $"\"{f.Name}\"").ToList();
            return new Schema
            {
                Kind = "PRIMITIVE",
                PrimitiveType = "string",
                Constraints = names.Count > 0 ? new Constraints { EnumValues = names } : null,
            };
        }

        // Arrays.
        if (type is IArrayTypeSymbol arr)
        {
            // byte[] → base64 string
            if (arr.ElementType.SpecialType == SpecialType.System_Byte)
            {
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "byte" };
            }
            return new Schema { Kind = "ARRAY", Items = Map(arr.ElementType) };
        }

        // Generic collections: IEnumerable<T>, List<T>, ICollection<T>, IReadOnlyList<T>, ...
        if (type is INamedTypeSymbol generic && generic.IsGenericType)
        {
            var def = generic.ConstructedFrom;
            if (IsEnumerableLike(def) && generic.TypeArguments.Length == 1)
            {
                return new Schema { Kind = "ARRAY", Items = Map(generic.TypeArguments[0]) };
            }
            if (IsDictionaryLike(def) && generic.TypeArguments.Length == 2)
            {
                // OpenAPI 3.1: dictionary → object with additionalProperties.
                // The current IR does not carry additionalProperties; emit as
                // empty OBJECT for MVP. Iter E may extend the IR.
                return new Schema { Kind = "OBJECT" };
            }
            // Wrappers we should unwrap: Task<T>, ValueTask<T>, ActionResult<T>.
            if (IsUnwrappableWrapper(def) && generic.TypeArguments.Length == 1)
            {
                return Map(generic.TypeArguments[0]);
            }
        }

        // Custom class → hoist to SharedSchemas and return REFERENCE.
        if (type is INamedTypeSymbol named && named.TypeKind == TypeKind.Class)
        {
            return _ctx.GetOrCreateReference(named, () => BuildClassSchema(named));
        }
        // Interface / struct fallback → empty OBJECT (caller decides).
        return new Schema { Kind = "OBJECT" };
    }

    private Schema BuildClassSchema(INamedTypeSymbol type)
    {
        var properties = new Dictionary<string, Schema>();
        var required = new List<string>();

        foreach (var member in type.GetMembers().OfType<IPropertySymbol>())
        {
            if (member.DeclaredAccessibility != Accessibility.Public) continue;
            if (member.IsStatic || member.IsIndexer) continue;
            if (member.GetMethod is null) continue;

            var propName = ToCamelCase(member.Name);
            var propSchema = Map(member.Type);
            propSchema = DataAnnotationReader.Apply(propSchema, member);
            properties[propName] = propSchema;

            if (IsRequired(member))
            {
                required.Add(propName);
            }
        }

        return new Schema
        {
            Kind = "OBJECT",
            Properties = properties.Count > 0 ? properties : null,
            RequiredProperties = required.Count > 0 ? required : null,
        };
    }

    private static bool IsRequired(IPropertySymbol property)
    {
        if (property.IsRequired) return true;
        // NRT: non-nullable reference type ⇒ required.
        if (property.Type.IsReferenceType
            && property.Type.NullableAnnotation == NullableAnnotation.NotAnnotated)
        {
            return true;
        }
        // Value type that is NOT Nullable<T> ⇒ required.
        if (property.Type.IsValueType
            && !(property.Type is INamedTypeSymbol nt
                 && nt.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T))
        {
            return true;
        }
        return false;
    }

    private static bool IsEnumerableLike(INamedTypeSymbol? def)
    {
        if (def is null) return false;
        var name = def.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return name is "global::System.Collections.Generic.IEnumerable<T>"
            or "global::System.Collections.Generic.ICollection<T>"
            or "global::System.Collections.Generic.IReadOnlyCollection<T>"
            or "global::System.Collections.Generic.IList<T>"
            or "global::System.Collections.Generic.IReadOnlyList<T>"
            or "global::System.Collections.Generic.List<T>"
            or "global::System.Collections.Generic.HashSet<T>"
            or "global::System.Collections.Generic.ISet<T>"
            or "global::System.Collections.Generic.IReadOnlySet<T>";
    }

    private static bool IsDictionaryLike(INamedTypeSymbol? def)
    {
        if (def is null) return false;
        var name = def.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return name is "global::System.Collections.Generic.IDictionary<TKey, TValue>"
            or "global::System.Collections.Generic.IReadOnlyDictionary<TKey, TValue>"
            or "global::System.Collections.Generic.Dictionary<TKey, TValue>";
    }

    private static bool IsUnwrappableWrapper(INamedTypeSymbol? def)
    {
        if (def is null) return false;
        var name = def.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return name is "global::System.Threading.Tasks.Task<TResult>"
            or "global::System.Threading.Tasks.ValueTask<TResult>"
            or "global::Microsoft.AspNetCore.Mvc.ActionResult<TValue>";
    }

    private static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        if (name.Length == 1) return name.ToLowerInvariant();
        return char.ToLowerInvariant(name[0]) + name.Substring(1);
    }
}
