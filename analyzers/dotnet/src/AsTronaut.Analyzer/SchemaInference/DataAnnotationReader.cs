using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Reads System.ComponentModel.DataAnnotations attributes off a symbol
// (typically a property or parameter) and merges them into an IR Schema.
//
// Supported annotations:
//   [Required]                        → property is required (handled by caller)
//   [StringLength(N)]                 → maxLength = N
//   [StringLength(N, MinimumLength=M)]→ maxLength = N, minLength = M
//   [MinLength(N)]                    → minLength = N
//   [MaxLength(N)]                    → maxLength = N
//   [Range(min, max)]                 → minimum/maximum
//   [RegularExpression(pattern)]      → pattern
//   [EmailAddress]                    → format = "email"
//   [Url]                             → format = "uri"
//   [Phone]                           → format = "phone"
//   [DataType(DataType.Date)]         → format = "date"
//   [DataType(DataType.DateTime)]     → format = "date-time"
//   [DataType(DataType.Password)]     → format = "password"
public static class DataAnnotationReader
{
    public static Schema Apply(Schema schema, ISymbol owner)
    {
        var attributes = owner.GetAttributes();
        if (attributes.Length == 0) return schema;

        var current = schema;
        var constraints = current.Constraints is null
            ? new Constraints()
            : new Constraints
            {
                Minimum = current.Constraints.Minimum,
                Maximum = current.Constraints.Maximum,
                ExclusiveMinimum = current.Constraints.ExclusiveMinimum,
                ExclusiveMaximum = current.Constraints.ExclusiveMaximum,
                MinLength = current.Constraints.MinLength,
                MaxLength = current.Constraints.MaxLength,
                MinItems = current.Constraints.MinItems,
                MaxItems = current.Constraints.MaxItems,
                UniqueItems = current.Constraints.UniqueItems,
                Pattern = current.Constraints.Pattern,
                EnumValues = current.Constraints.EnumValues,
                MultipleOf = current.Constraints.MultipleOf,
            };

        var touched = current.Constraints is not null;
        string? formatOverride = current.Format;

        foreach (var attr in attributes)
        {
            var name = AttrName(attr);
            switch (name)
            {
                case "StringLength":
                    if (TryGetInt(attr.ConstructorArguments, 0, out var maxLen))
                    {
                        constraints.MaxLength = maxLen;
                        touched = true;
                    }
                    var minProp = GetNamedInt(attr, "MinimumLength");
                    if (minProp.HasValue)
                    {
                        constraints.MinLength = minProp.Value;
                        touched = true;
                    }
                    break;
                case "MinLength":
                    if (TryGetInt(attr.ConstructorArguments, 0, out var mn))
                    {
                        constraints.MinLength = mn;
                        touched = true;
                    }
                    break;
                case "MaxLength":
                    if (TryGetInt(attr.ConstructorArguments, 0, out var mx))
                    {
                        constraints.MaxLength = mx;
                        touched = true;
                    }
                    break;
                case "Range":
                    var (rmin, rmax) = ReadRange(attr);
                    if (rmin.HasValue)
                    {
                        constraints.Minimum = rmin.Value;
                        touched = true;
                    }
                    if (rmax.HasValue)
                    {
                        constraints.Maximum = rmax.Value;
                        touched = true;
                    }
                    break;
                case "RegularExpression":
                    if (attr.ConstructorArguments.Length > 0
                        && attr.ConstructorArguments[0].Value is string pattern)
                    {
                        constraints.Pattern = pattern;
                        touched = true;
                    }
                    break;
                case "EmailAddress":
                    formatOverride = "email";
                    break;
                case "Url":
                    formatOverride = "uri";
                    break;
                case "Phone":
                    formatOverride = "phone";
                    break;
                case "DataType":
                    var dt = ReadDataTypeEnum(attr);
                    if (dt is not null) formatOverride = dt;
                    break;
            }
        }

        if (!touched && formatOverride == current.Format) return current;
        return current with
        {
            Format = formatOverride,
            Constraints = touched ? constraints : current.Constraints,
        };
    }

    private static string AttrName(AttributeData attr)
    {
        var n = attr.AttributeClass?.Name ?? "";
        return n.EndsWith("Attribute", StringComparison.Ordinal)
            ? n.Substring(0, n.Length - 9)
            : n;
    }

    private static bool TryGetInt(
        System.Collections.Immutable.ImmutableArray<TypedConstant> args, int index, out int value)
    {
        value = 0;
        if (index >= args.Length) return false;
        var v = args[index].Value;
        if (v is int i) { value = i; return true; }
        if (v is long l) { value = (int)l; return true; }
        return false;
    }

    private static int? GetNamedInt(AttributeData attr, string name)
    {
        foreach (var pair in attr.NamedArguments)
        {
            if (pair.Key == name && pair.Value.Value is int i) return i;
        }
        return null;
    }

    private static (double? Min, double? Max) ReadRange(AttributeData attr)
    {
        if (attr.ConstructorArguments.Length < 2) return (null, null);
        var a = attr.ConstructorArguments[0].Value;
        var b = attr.ConstructorArguments[1].Value;
        return (AsDouble(a), AsDouble(b));
    }

    private static double? AsDouble(object? v) => v switch
    {
        int i => i,
        long l => l,
        double d => d,
        float f => f,
        decimal dec => (double)dec,
        _ => null,
    };

    private static string? ReadDataTypeEnum(AttributeData attr)
    {
        if (attr.ConstructorArguments.Length == 0) return null;
        var arg = attr.ConstructorArguments[0];
        if (arg.Type?.TypeKind != TypeKind.Enum) return null;
        if (arg.Value is not int ordinal) return null;
        // System.ComponentModel.DataAnnotations.DataType enum members.
        return ordinal switch
        {
            2 => "date-time",
            3 => "date",
            4 => "time",
            5 => "duration",
            6 => "phone",
            10 => "uri",
            11 => "email",
            12 => "password",
            _ => null,
        };
    }
}
