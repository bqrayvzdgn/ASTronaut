using System.Text.RegularExpressions;
using AsTronaut.Analyzer.Ir;

namespace AsTronaut.Analyzer.Controllers;

public static class RouteTemplateParser
{
    private static readonly Regex SegmentRegex = new("\\{([^}]+)\\}", RegexOptions.Compiled);

    public sealed record Result(string NormalizedPath, List<ParamInfo> PathParams);

    public static Result Parse(string template)
    {
        var raw = template.Trim();
        if (raw.Length > 1 && raw.EndsWith('/')) raw = raw.TrimEnd('/');
        if (!raw.StartsWith('/')) raw = "/" + raw;

        var pathParams = new List<ParamInfo>();
        var normalized = SegmentRegex.Replace(raw, match =>
        {
            var token = match.Groups[1].Value;
            var (name, schema) = ParseToken(token);
            if (!string.IsNullOrEmpty(name))
            {
                pathParams.Add(new ParamInfo { Name = name, Schema = schema, Required = true });
            }
            return "{" + name + "}";
        });

        return new Result(normalized, pathParams);
    }

    private static (string Name, Schema Schema) ParseToken(string token)
    {
        var work = token;
        if (work.StartsWith("**")) work = work.Substring(2);
        else if (work.StartsWith('*')) work = work.Substring(1);
        var eq = work.IndexOf('=');
        if (eq >= 0) work = work.Substring(0, eq);
        if (work.EndsWith('?')) work = work.Substring(0, work.Length - 1);

        var parts = SplitConstraints(work);
        var name = parts.Count > 0 ? parts[0] : work;
        var constraintsRaw = parts.Skip(1).ToList();

        var schema = new Schema { Kind = Schema.Types.Kind.Primitive, PrimitiveType = "string" };
        var constraints = new Constraints();
        var hasConstraint = false;

        foreach (var c in constraintsRaw)
        {
            ApplyConstraint(c, schema, constraints, ref hasConstraint);
        }
        if (hasConstraint)
        {
            schema.Constraints = constraints;
        }
        return (name, schema);
    }

    private static List<string> SplitConstraints(string token)
    {
        var parts = new List<string>();
        var depth = 0;
        var start = 0;
        for (int i = 0; i < token.Length; i++)
        {
            var ch = token[i];
            if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (ch == ':' && depth == 0)
            {
                parts.Add(token.Substring(start, i - start));
                start = i + 1;
            }
        }
        parts.Add(token.Substring(start));
        return parts;
    }

    private static void ApplyConstraint(
        string raw,
        Schema schema,
        Constraints constraints,
        ref bool hasConstraint)
    {
        var (name, arg) = SplitConstraintCall(raw);
        switch (name)
        {
            case "int":
                schema.PrimitiveType = "integer";
                schema.Format = "int32";
                return;
            case "long":
                schema.PrimitiveType = "integer";
                schema.Format = "int64";
                return;
            case "float":
                schema.PrimitiveType = "number";
                schema.Format = "float";
                return;
            case "double":
                schema.PrimitiveType = "number";
                schema.Format = "double";
                return;
            case "decimal":
                schema.PrimitiveType = "number";
                schema.Format = "decimal";
                return;
            case "bool":
                schema.PrimitiveType = "boolean";
                schema.ClearFormat();
                return;
            case "datetime":
                schema.PrimitiveType = "string";
                schema.Format = "date-time";
                return;
            case "guid":
                schema.PrimitiveType = "string";
                schema.Format = "uuid";
                return;
            case "alpha":
                constraints.Pattern = "^[A-Za-z]+$";
                hasConstraint = true;
                return;
            case "min":
                if (double.TryParse(arg, System.Globalization.NumberStyles.Number,
                        System.Globalization.CultureInfo.InvariantCulture, out var min))
                {
                    constraints.Minimum = min;
                    hasConstraint = true;
                }
                return;
            case "max":
                if (double.TryParse(arg, System.Globalization.NumberStyles.Number,
                        System.Globalization.CultureInfo.InvariantCulture, out var max))
                {
                    constraints.Maximum = max;
                    hasConstraint = true;
                }
                return;
            case "range":
                var rangeParts = arg.Split(',');
                if (rangeParts.Length == 2
                    && double.TryParse(rangeParts[0], System.Globalization.NumberStyles.Number,
                        System.Globalization.CultureInfo.InvariantCulture, out var lo)
                    && double.TryParse(rangeParts[1], System.Globalization.NumberStyles.Number,
                        System.Globalization.CultureInfo.InvariantCulture, out var hi))
                {
                    constraints.Minimum = lo;
                    constraints.Maximum = hi;
                    hasConstraint = true;
                }
                return;
            case "minlength":
                if (int.TryParse(arg, out var mn))
                {
                    constraints.MinLength = mn;
                    hasConstraint = true;
                }
                return;
            case "maxlength":
                if (int.TryParse(arg, out var mx))
                {
                    constraints.MaxLength = mx;
                    hasConstraint = true;
                }
                return;
            case "length":
                var lengthParts = arg.Split(',');
                if (lengthParts.Length == 1 && int.TryParse(lengthParts[0], out var exact))
                {
                    constraints.MinLength = exact;
                    constraints.MaxLength = exact;
                    hasConstraint = true;
                }
                else if (lengthParts.Length == 2
                         && int.TryParse(lengthParts[0], out var lmin)
                         && int.TryParse(lengthParts[1], out var lmax))
                {
                    constraints.MinLength = lmin;
                    constraints.MaxLength = lmax;
                    hasConstraint = true;
                }
                return;
            case "regex":
                if (!string.IsNullOrEmpty(arg))
                {
                    constraints.Pattern = arg;
                    hasConstraint = true;
                }
                return;
        }
    }

    private static (string Name, string Arg) SplitConstraintCall(string raw)
    {
        var paren = raw.IndexOf('(');
        if (paren < 0) return (raw, string.Empty);
        var name = raw.Substring(0, paren);
        var arg = raw.Substring(paren + 1);
        if (arg.EndsWith(')')) arg = arg.Substring(0, arg.Length - 1);
        return (name, arg);
    }
}
