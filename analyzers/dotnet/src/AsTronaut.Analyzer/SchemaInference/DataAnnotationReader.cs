using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

public static class DataAnnotationReader
{
    public static Schema Apply(Schema schema, ISymbol owner)
    {
        var attributes = owner.GetAttributes();
        if (attributes.Length == 0) return schema;

        var current = schema;
        var constraints = current.Constraints is null
            ? new Constraints()
            : current.Constraints.Clone();

        var touched = current.Constraints is not null;
        string? currentFormat = current.HasFormat ? current.Format : null;
        string? formatOverride = currentFormat;

        var isCollection = current.Kind == Schema.Types.Kind.Array;

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

        if (!touched && formatOverride == currentFormat) return current;
        var updated = current.Clone();
        if (formatOverride is null) updated.ClearFormat();
        else updated.Format = formatOverride;
        updated.Constraints = touched ? constraints : current.Constraints;
        return updated;
    }

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
