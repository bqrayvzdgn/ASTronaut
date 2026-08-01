using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Maps a Roslyn ITypeSymbol to an IR Schema. Handles primitives, well-known
// .NET types, nullables (Nullable<T> + C# 8 NRT), arrays/collections, and
// custom classes (hoisted into SharedSchemas via SchemaContext).
public sealed class TypeToSchema
{
    private readonly SchemaContext _ctx;
    private readonly bool _stringEnumsByDefault;

    public TypeToSchema(SchemaContext ctx, bool stringEnumsByDefault = false)
    {
        _ctx = ctx;
        _stringEnumsByDefault = stringEnumsByDefault;
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
            case "global::Microsoft.AspNetCore.Http.IFormFile":
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "binary" };
            case "global::Microsoft.AspNetCore.Http.IFormFileCollection":
                return new Schema
                {
                    Kind = "ARRAY",
                    Items = new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "binary" },
                };
        }

        // Enums → integer (System.Text.Json default) with numeric enum values,
        // or string with member names when a string-enum converter applies.
        if (type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol enumType)
        {
            return BuildEnumSchema(enumType);
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
                // Dictionary<TKey, TValue> → object with additionalProperties (the
                // value schema). OpenAPI object keys are always strings.
                return new Schema
                {
                    Kind = "OBJECT",
                    AdditionalProperties = Map(generic.TypeArguments[1]),
                };
            }
            // Wrappers we should unwrap: Task<T>, ValueTask<T>, ActionResult<T>.
            if (IsUnwrappableWrapper(def) && generic.TypeArguments.Length == 1)
            {
                return Map(generic.TypeArguments[0]);
            }
        }

        // Custom class → hoist to SharedSchemas and return REFERENCE. A class
        // marked [JsonPolymorphic] hoists as a discriminated ONE_OF instead.
        if (type is INamedTypeSymbol named && named.TypeKind == TypeKind.Class)
        {
            return HasPolymorphism(named)
                ? _ctx.GetOrCreateReference(named, () => BuildPolymorphicSchema(named))
                : _ctx.GetOrCreateReference(named, () => BuildClassSchema(named));
        }
        // Interface / struct fallback → empty OBJECT (caller decides).
        return new Schema { Kind = "OBJECT" };
    }

    private Schema BuildEnumSchema(INamedTypeSymbol enumType)
    {
        var members = enumType.GetMembers().OfType<IFieldSymbol>().Where(f => f.IsConst).ToList();
        var asString = _stringEnumsByDefault || HasStringEnumConverter(enumType);

        if (asString)
        {
            var names = members.Select(f => $"\"{f.Name}\"").ToList();
            return new Schema
            {
                Kind = "PRIMITIVE",
                PrimitiveType = "string",
                Constraints = names.Count > 0 ? new Constraints { EnumValues = names } : null,
            };
        }

        // Numeric enum: emit the underlying constant values as JSON number literals.
        var values = members
            .Select(f => f.ConstantValue?.ToString() ?? "0")
            .ToList();
        var format = enumType.EnumUnderlyingType?.SpecialType
            is SpecialType.System_Int64 or SpecialType.System_UInt64
                ? "int64"
                : "int32";
        return new Schema
        {
            Kind = "PRIMITIVE",
            PrimitiveType = "integer",
            Format = format,
            Constraints = values.Count > 0 ? new Constraints { EnumValues = values } : null,
        };
    }

    // A [JsonConverter(typeof(JsonStringEnumConverter))] (System.Text.Json) or
    // [JsonConverter(typeof(StringEnumConverter))] (Newtonsoft) on the enum type
    // forces string serialization regardless of the global default.
    private static bool HasStringEnumConverter(INamedTypeSymbol enumType)
    {
        var attr = AttributeReader.FindAttribute(enumType, "JsonConverter");
        if (attr is null) return false;
        foreach (var arg in attr.ConstructorArguments)
        {
            if (arg.Value is INamedTypeSymbol conv
                && conv.Name.Contains("StringEnum", StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    // True when `type` is a [JsonPolymorphic] base declaring [JsonDerivedType]s.
    private static bool HasPolymorphism(INamedTypeSymbol type) =>
        AttributeReader.HasAttribute(type, "JsonPolymorphic")
        && AttributeReader.FindAttribute(type, "JsonDerivedType") is not null;

    // [JsonPolymorphic] + [JsonDerivedType(typeof(T), "disc")] → discriminated
    // ONE_OF: each derived type is a variant, with a value→refName mapping.
    private Schema BuildPolymorphicSchema(INamedTypeSymbol baseType)
    {
        var variants = new List<Schema>();
        var mapping = new Dictionary<string, string>();

        foreach (var attr in AttributeReader.FindAttributes(baseType, "JsonDerivedType"))
        {
            if (attr.ConstructorArguments.Length == 0) continue;
            if (attr.ConstructorArguments[0].Value is not INamedTypeSymbol derivedType) continue;

            var variant = Map(derivedType); // REFERENCE to the hoisted derived schema
            variants.Add(variant);

            if (attr.ConstructorArguments.Length >= 2 && variant.RefName is not null)
            {
                var disc = attr.ConstructorArguments[1].Value?.ToString();
                if (!string.IsNullOrEmpty(disc)) mapping[disc!] = variant.RefName;
            }
        }

        var propAttr = AttributeReader.FindAttribute(baseType, "JsonPolymorphic");
        var propName = propAttr is null
            ? "$type"
            : AttributeReader.GetNamedStringArg(propAttr, "TypeDiscriminatorPropertyName") ?? "$type";

        return new Schema
        {
            Kind = "ONE_OF",
            Variants = variants,
            Discriminator = propName,
            DiscriminatorMapping = mapping.Count > 0 ? mapping : null,
        };
    }

    private Schema BuildClassSchema(INamedTypeSymbol type)
    {
        var properties = new Dictionary<string, Schema>();
        var required = new List<string>();

        // Walk the inheritance chain most-derived first so derived properties
        // win over inherited ones with the same serialized name.
        for (var t = type; t is not null && t.SpecialType != SpecialType.System_Object; t = t.BaseType)
        {
            foreach (var member in t.GetMembers().OfType<IPropertySymbol>())
            {
                if (member.DeclaredAccessibility != Accessibility.Public) continue;
                if (member.IsStatic || member.IsIndexer) continue;
                if (member.GetMethod is null) continue;
                if (IsJsonIgnored(member)) continue;

                var propName = ResolvePropertyName(member);
                if (properties.ContainsKey(propName)) continue;

                var propSchema = Map(member.Type);
                propSchema = DataAnnotationReader.Apply(propSchema, member);
                properties[propName] = propSchema;

                if (IsRequired(member))
                {
                    required.Add(propName);
                }
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

    // Resolves the serialized property name, honoring explicit serialization
    // attributes so the emitted schema matches the real wire format. Falls back
    // to ASP.NET Core's System.Text.Json default camelCase policy.
    private static string ResolvePropertyName(IPropertySymbol member)
    {
        // System.Text.Json: [JsonPropertyName("...")].
        var jpn = AttributeReader.FindAttribute(member, "JsonPropertyName");
        if (jpn is not null
            && AttributeReader.GetStringArg(jpn, 0) is { Length: > 0 } explicitName)
        {
            return explicitName;
        }

        // Newtonsoft.Json: [JsonProperty("...")] or [JsonProperty(PropertyName = "...")].
        var jp = AttributeReader.FindAttribute(member, "JsonProperty");
        if (jp is not null)
        {
            var np = AttributeReader.GetStringArg(jp, 0)
                     ?? AttributeReader.GetNamedStringArg(jp, "PropertyName");
            if (!string.IsNullOrEmpty(np)) return np!;
        }

        return ToCamelCase(member.Name);
    }

    // True when the property is dropped from serialization entirely. Only an
    // unconditional [JsonIgnore] (Condition=Always, the default) is dropped;
    // conditional forms (WhenWritingNull/WhenWritingDefault) still serialize
    // the property, so those remain in the schema.
    private static bool IsJsonIgnored(IPropertySymbol member)
    {
        var attr = AttributeReader.FindAttribute(member, "JsonIgnore");
        if (attr is null) return false;
        foreach (var na in attr.NamedArguments)
        {
            if (na.Key == "Condition")
            {
                // JsonIgnoreCondition: Never=0, Always=1, WhenWritingDefault=2, WhenWritingNull=3.
                return na.Value.Value is int c && c == 1;
            }
        }
        return true; // No Condition ⇒ Always (Newtonsoft, or STJ default).
    }

    private static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        if (name.Length == 1) return name.ToLowerInvariant();
        return char.ToLowerInvariant(name[0]) + name.Substring(1);
    }
}
