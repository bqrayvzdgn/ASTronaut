using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

public sealed class TypeToSchema
{
    private readonly SchemaContext _ctx;
    private readonly bool _stringEnumsByDefault;
    private readonly JsonNamingPolicyKind? _namingPolicy;

    public TypeToSchema(
        SchemaContext ctx,
        bool stringEnumsByDefault = false,
        JsonNamingPolicyKind? namingPolicy = null)
    {
        _ctx = ctx;
        _stringEnumsByDefault = stringEnumsByDefault;
        _namingPolicy = namingPolicy;
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
            case "global::System.Text.Json.JsonDocument":
            case "global::System.Text.Json.JsonElement":
            case "global::System.Text.Json.Nodes.JsonNode":
            case "global::System.Text.Json.Nodes.JsonObject":
            case "global::Newtonsoft.Json.Linq.JObject":
            case "global::Newtonsoft.Json.Linq.JToken":
                return new Schema { Kind = "OBJECT" };
        }

        if (type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol enumType)
        {
            return BuildEnumSchema(enumType);
        }

        if (type is IArrayTypeSymbol arr)
        {
            if (arr.ElementType.SpecialType == SpecialType.System_Byte)
            {
                return new Schema { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "byte" };
            }
            return new Schema { Kind = "ARRAY", Items = Map(arr.ElementType) };
        }

        if (type is INamedTypeSymbol tuple && tuple.IsTupleType)
        {
            return BuildTupleSchema(tuple);
        }

        if (type is INamedTypeSymbol generic && generic.IsGenericType)
        {
            var def = generic.ConstructedFrom;
            if (IsEnumerableLike(def) && generic.TypeArguments.Length == 1)
            {
                return new Schema { Kind = "ARRAY", Items = Map(generic.TypeArguments[0]) };
            }
            if (IsDictionaryLike(def) && generic.TypeArguments.Length == 2)
            {
                return new Schema
                {
                    Kind = "OBJECT",
                    AdditionalProperties = Map(generic.TypeArguments[1]),
                };
            }
            if (IsUnwrappableWrapper(def) && generic.TypeArguments.Length == 1)
            {
                return Map(generic.TypeArguments[0]);
            }
        }

        if (type is INamedTypeSymbol named
            && named.TypeKind is TypeKind.Class or TypeKind.Struct)
        {
            if (named.IsAnonymousType) return BuildClassSchema(named);
            return HasPolymorphism(named)
                ? _ctx.GetOrCreateReference(named, () => BuildPolymorphicSchema(named))
                : _ctx.GetOrCreateReference(named, () => BuildClassSchema(named));
        }
        return new Schema { Kind = "OBJECT" };
    }

    private Schema BuildEnumSchema(INamedTypeSymbol enumType)
    {
        var members = enumType.GetMembers().OfType<IFieldSymbol>().Where(f => f.IsConst).ToList();
        var asString = _stringEnumsByDefault || HasStringEnumConverter(enumType);

        if (asString)
        {
            var names = members.Select(f => $"\"{ResolveEnumMemberName(f)}\"").ToList();
            return new Schema
            {
                Kind = "PRIMITIVE",
                PrimitiveType = "string",
                Constraints = names.Count > 0 ? new Constraints { EnumValues = names } : null,
            };
        }

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

    private static string ResolveEnumMemberName(IFieldSymbol member)
    {
        var jpn = AttributeReader.FindAttribute(member, "JsonPropertyName");
        if (jpn is not null
            && AttributeReader.GetStringArg(jpn, 0) is { Length: > 0 } explicitName)
        {
            return explicitName;
        }

        var em = AttributeReader.FindAttribute(member, "EnumMember");
        if (em is not null
            && AttributeReader.GetNamedStringArg(em, "Value") is { Length: > 0 } emValue)
        {
            return emValue;
        }

        return member.Name;
    }

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

    private static bool HasPolymorphism(INamedTypeSymbol type) =>
        AttributeReader.HasAttribute(type, "JsonPolymorphic")
        && AttributeReader.FindAttribute(type, "JsonDerivedType") is not null;

    private Schema BuildPolymorphicSchema(INamedTypeSymbol baseType)
    {
        var variants = new List<Schema>();
        var mapping = new Dictionary<string, string>();

        foreach (var attr in AttributeReader.FindAttributes(baseType, "JsonDerivedType"))
        {
            if (attr.ConstructorArguments.Length == 0) continue;
            if (attr.ConstructorArguments[0].Value is not INamedTypeSymbol derivedType) continue;

            var variant = Map(derivedType);
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

                if (IsRequired(member) || DataAnnotationReader.HasRequired(member))
                {
                    required.Add(propName);
                }
            }

            foreach (var field in t.GetMembers().OfType<IFieldSymbol>())
            {
                if (field.DeclaredAccessibility != Accessibility.Public) continue;
                if (field.IsStatic || field.IsConst) continue;
                if (!AttributeReader.HasAttribute(field, "JsonInclude")) continue;

                var fieldName = ResolvePropertyName(field);
                if (properties.ContainsKey(fieldName)) continue;

                var fieldSchema = Map(field.Type);
                fieldSchema = DataAnnotationReader.Apply(fieldSchema, field);
                properties[fieldName] = fieldSchema;

                if (IsRequiredMember(field.Type, field.IsRequired)
                    || DataAnnotationReader.HasRequired(field))
                {
                    required.Add(fieldName);
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

    private Schema BuildTupleSchema(INamedTypeSymbol tuple)
    {
        var properties = new Dictionary<string, Schema>();
        var required = new List<string>();

        var index = 0;
        foreach (var element in tuple.TupleElements)
        {
            index++;
            var name = string.IsNullOrEmpty(element.Name) ? $"Item{index}" : element.Name;
            if (properties.ContainsKey(name)) continue;

            properties[name] = Map(element.Type);
            if (IsRequiredMember(element.Type, requiredKeyword: false))
            {
                required.Add(name);
            }
        }

        return new Schema
        {
            Kind = "OBJECT",
            Properties = properties.Count > 0 ? properties : null,
            RequiredProperties = required.Count > 0 ? required : null,
        };
    }

    private static bool IsRequired(IPropertySymbol property) =>
        IsRequiredMember(property.Type, property.IsRequired);

    private static bool IsRequiredMember(ITypeSymbol type, bool requiredKeyword)
    {
        if (requiredKeyword) return true;
        if (type.IsReferenceType
            && type.NullableAnnotation == NullableAnnotation.NotAnnotated)
        {
            return true;
        }
        if (type.IsValueType
            && !(type is INamedTypeSymbol nt
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
            or "global::System.Collections.Generic.IReadOnlySet<T>"
            or "global::System.Collections.Generic.IAsyncEnumerable<T>";
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

    private string ResolvePropertyName(ISymbol member)
    {
        var jpn = AttributeReader.FindAttribute(member, "JsonPropertyName");
        if (jpn is not null
            && AttributeReader.GetStringArg(jpn, 0) is { Length: > 0 } explicitName)
        {
            return explicitName;
        }

        var jp = AttributeReader.FindAttribute(member, "JsonProperty");
        if (jp is not null)
        {
            var np = AttributeReader.GetStringArg(jp, 0)
                     ?? AttributeReader.GetNamedStringArg(jp, "PropertyName");
            if (!string.IsNullOrEmpty(np)) return np!;
        }

        return ApplyNamingPolicy(member.Name);
    }

    private string ApplyNamingPolicy(string name) => _namingPolicy switch
    {
        JsonNamingPolicyKind.AsIs => name,
        JsonNamingPolicyKind.SnakeCaseLower => ConvertCase(name, '_', upper: false),
        JsonNamingPolicyKind.SnakeCaseUpper => ConvertCase(name, '_', upper: true),
        JsonNamingPolicyKind.KebabCaseLower => ConvertCase(name, '-', upper: false),
        JsonNamingPolicyKind.KebabCaseUpper => ConvertCase(name, '-', upper: true),
        _ => ToCamelCase(name),
    };

    private static string ConvertCase(string name, char separator, bool upper)
    {
        if (string.IsNullOrEmpty(name)) return name;
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c) && i > 0)
            {
                var prev = name[i - 1];
                var prevBoundary = char.IsLower(prev) || char.IsDigit(prev);
                var nextLower = i + 1 < name.Length && char.IsLower(name[i + 1]);
                if ((prevBoundary || nextLower)
                    && sb.Length > 0 && sb[sb.Length - 1] != separator)
                {
                    sb.Append(separator);
                }
            }
            sb.Append(upper ? char.ToUpperInvariant(c) : char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    private static bool IsJsonIgnored(IPropertySymbol member)
    {
        var attr = AttributeReader.FindAttribute(member, "JsonIgnore");
        if (attr is null) return false;
        foreach (var na in attr.NamedArguments)
        {
            if (na.Key == "Condition")
            {
                return na.Value.Value is int c && c == 1;
            }
        }
        return true;
    }

    private static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        if (name.Length == 1) return name.ToLowerInvariant();
        return char.ToLowerInvariant(name[0]) + name.Substring(1);
    }
}
