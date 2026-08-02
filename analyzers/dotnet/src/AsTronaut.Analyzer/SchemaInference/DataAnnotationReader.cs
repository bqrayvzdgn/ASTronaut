using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Reads System.ComponentModel.DataAnnotations attributes off a symbol
// (typically a property or parameter) and merges them into an IR Schema.
//
// Supported annotations:
//   [Required]                        → property is required (handled by caller)
//   [StringLength(N)]                 → maxLength = N  (string only)
//   [StringLength(N, MinimumLength=M)]→ maxLength = N, minLength = M
//   [MinLength(N)]                    → minLength/minItems (by target type)
//   [MaxLength(N)]                    → maxLength/maxItems (by target type)
//   [Range(min, max)]                 → minimum/maximum
//   [Range(.., MinimumIsExclusive=true)] → exclusiveMinimum/exclusiveMaximum
//   [Length(min, max)]                → min/maxLength or min/maxItems (by type)
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

        // MinLength/MaxLength/Length are dual-purpose in .NET: on a string they
        // constrain character count, on a collection they constrain item count.
        // The mapped schema already tells us which — arrays map to ARRAY, strings
        // (and byte[]) to a PRIMITIVE — so key the emitted constraint off Kind.
        var isCollection = string.Equals(current.Kind, "ARRAY", StringComparison.Ordinal);

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
                        if (isCollection) constraints.MinItems = mn;
                        else constraints.MinLength = mn;
                        touched = true;
                    }
                    break;
                case "MaxLength":
                    if (TryGetInt(attr.ConstructorArguments, 0, out var mx))
                    {
                        if (isCollection) constraints.MaxItems = mx;
                        else constraints.MaxLength = mx;
                        touched = true;
                    }
                    break;
                case "Range":
                    var (rmin, rmax) = ReadRange(attr);
                    // .NET 8+ RangeAttribute can mark either bound exclusive.
                    var minExclusive = GetNamedBool(attr, "MinimumIsExclusive") == true;
                    var maxExclusive = GetNamedBool(attr, "MaximumIsExclusive") == true;
                    if (rmin.HasValue)
                    {
                        if (minExclusive) constraints.ExclusiveMinimum = rmin.Value;
                        else constraints.Minimum = rmin.Value;
                        touched = true;
                    }
                    if (rmax.HasValue)
                    {
                        if (maxExclusive) constraints.ExclusiveMaximum = rmax.Value;
                        else constraints.Maximum = rmax.Value;
                        touched = true;
                    }
                    break;
                case "Length":
                    // System.ComponentModel.DataAnnotations.LengthAttribute(min, max)
                    // constrains string length OR collection item count depending on
                    // the target type → min/maxLength for strings, min/maxItems for
                    // collections.
                    if (TryGetInt(attr.ConstructorArguments, 0, out var lmin))
                    {
                        if (isCollection) constraints.MinItems = lmin;
                        else constraints.MinLength = lmin;
                        touched = true;
                    }
                    if (TryGetInt(attr.ConstructorArguments, 1, out var lmax))
                    {
                        if (isCollection) constraints.MaxItems = lmax;
                        else constraints.MaxLength = lmax;
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

    // True when the member carries a [Required] annotation
    // (System.ComponentModel.DataAnnotations). Required-ness driven by an explicit
    // annotation overrides nullability-based inference at the call site.
    public static bool HasRequired(ISymbol owner)
    {
        foreach (var attr in owner.GetAttributes())
        {
            if (AttrName(attr) == "Required") return true;
        }
        return false;
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

    private static bool? GetNamedBool(AttributeData attr, string name)
    {
        foreach (var pair in attr.NamedArguments)
        {
            if (pair.Key == name && pair.Value.Value is bool b) return b;
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
        // System.ComponentModel.DataAnnotations.DataType enum members, by ordinal:
        //   Custom=0, DateTime=1, Date=2, Time=3, Duration=4, PhoneNumber=5,
        //   Currency=6, Text=7, Html=8, MultilineText=9, EmailAddress=10,
        //   Password=11, Url=12, ImageUrl=13, CreditCard=14, PostalCode=15,
        //   Upload=16. Members without a sensible OpenAPI format map to null.
        return ordinal switch
        {
            1 => "date-time",
            2 => "date",
            3 => "time",
            4 => "duration",
            5 => "phone",
            10 => "email",
            11 => "password",
            12 => "uri",
            13 => "uri",
            16 => "binary",
            _ => null,
        };
    }
}
