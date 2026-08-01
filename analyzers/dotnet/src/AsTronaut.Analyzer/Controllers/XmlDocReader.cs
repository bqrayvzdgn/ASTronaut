using System.Globalization;
using System.Text;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Reads XML documentation comments off a Roslyn ISymbol via
// GetDocumentationCommentXml(). Returns the <summary> text, a per-parameter
// map of <param name="..."> text, and per-status <response code="NNN">
// descriptions. Inline doc tags (<c>/<code>/<see cref>/<see langword>/
// <paramref>) are flattened to plain text. Implementation is defensive:
// malformed XML returns empty results rather than throwing.
public sealed class XmlDocReader
{
    public string? Summary { get; }
    public string? Description { get; }
    public IReadOnlyDictionary<string, string> Params { get; }
    public string? Returns { get; }

    // Per-status descriptions from <response code="NNN">text</response> tags
    // (ASP.NET Core / Swashbuckle convention). Empty when none are present.
    public IReadOnlyDictionary<int, string> ResponseDescriptions { get; }

    private static readonly IReadOnlyDictionary<string, string> EmptyParams =
        new Dictionary<string, string>();

    private static readonly IReadOnlyDictionary<int, string> EmptyResponses =
        new Dictionary<int, string>();

    private XmlDocReader(
        string? summary,
        string? description,
        Dictionary<string, string> @params,
        string? returns,
        Dictionary<int, string> responseDescriptions)
    {
        Summary = summary;
        Description = description;
        Params = @params;
        Returns = returns;
        ResponseDescriptions = responseDescriptions;
    }

    public static XmlDocReader From(ISymbol symbol)
    {
        var xml = symbol.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml))
        {
            return new XmlDocReader(null, null, new Dictionary<string, string>(), null, new Dictionary<int, string>());
        }
        try
        {
            // Roslyn typically wraps the body in <member name="...">. Wrap it
            // in a synthetic root so XDocument.Parse accepts either form.
            var doc = XDocument.Parse("<doc>" + xml + "</doc>");
            var summary = ReadElement(doc, "summary");
            var remarks = ReadElement(doc, "remarks");
            var returns = ReadElement(doc, "returns");

            var paramMap = new Dictionary<string, string>();
            foreach (var p in doc.Descendants("param"))
            {
                var name = p.Attribute("name")?.Value;
                if (string.IsNullOrEmpty(name)) continue;
                var text = Normalize(FlattenText(p));
                if (!string.IsNullOrWhiteSpace(text)) paramMap[name] = text;
            }

            var responses = new Dictionary<int, string>();
            foreach (var r in doc.Descendants("response"))
            {
                var codeAttr = r.Attribute("code")?.Value;
                if (string.IsNullOrEmpty(codeAttr)) continue;
                if (!int.TryParse(codeAttr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var code)) continue;
                var text = Normalize(FlattenText(r));
                if (!string.IsNullOrWhiteSpace(text)) responses[code] = text;
            }

            return new XmlDocReader(summary, remarks, paramMap, returns, responses);
        }
        catch
        {
            return new XmlDocReader(null, null, new Dictionary<string, string>(), null, new Dictionary<int, string>());
        }
    }

    public static XmlDocReader Empty() => new(null, null, new Dictionary<string, string>(), null, new Dictionary<int, string>());

    private static string? ReadElement(XDocument doc, string name)
    {
        var el = doc.Descendants(name).FirstOrDefault();
        if (el is null) return null;
        var text = Normalize(FlattenText(el));
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    // Recursively flattens an element's mixed content to plain text, reducing
    // common inline doc tags to their textual meaning:
    //   <c>x</c> / <code>x</code>           -> x
    //   <see cref="T:Foo.Bar"/>             -> Bar
    //   <see cref="Foo">display</see>       -> display
    //   <see langword="null"/>              -> null
    //   <paramref name="x"/>                -> x
    // Any other tag is stripped but its inner text is preserved, so unknown or
    // malformed inline tags degrade gracefully.
    private static string FlattenText(XElement element)
    {
        var sb = new StringBuilder();
        AppendChildren(sb, element);
        return sb.ToString();
    }

    private static void AppendChildren(StringBuilder sb, XElement element)
    {
        foreach (var node in element.Nodes())
        {
            switch (node)
            {
                case XText text:
                    sb.Append(text.Value);
                    break;
                case XElement child:
                    AppendElement(sb, child);
                    break;
            }
        }
    }

    private static void AppendElement(StringBuilder sb, XElement e)
    {
        switch (e.Name.LocalName)
        {
            case "see":
            case "seealso":
                // Prefer explicit display text: <see cref="Foo">text</see>.
                var inner = FlattenText(e);
                if (!string.IsNullOrWhiteSpace(inner))
                {
                    sb.Append(inner);
                    break;
                }
                var cref = e.Attribute("cref")?.Value;
                if (!string.IsNullOrEmpty(cref))
                {
                    sb.Append(SimpleName(cref));
                    break;
                }
                var langword = e.Attribute("langword")?.Value;
                if (!string.IsNullOrEmpty(langword))
                {
                    sb.Append(langword);
                    break;
                }
                var href = e.Attribute("href")?.Value;
                if (!string.IsNullOrEmpty(href)) sb.Append(href);
                break;

            case "paramref":
            case "typeparamref":
                var name = e.Attribute("name")?.Value;
                if (!string.IsNullOrEmpty(name)) sb.Append(name);
                break;

            default:
                // <c>, <code>, <para>, and any other tag: keep inner content.
                AppendChildren(sb, e);
                break;
        }
    }

    // Reduces an XML doc cref (e.g. "T:Foo.Bar", "M:Foo.Bar(System.Int32)",
    // "Foo`1") to a simple type/member name ("Bar", "Bar", "Foo").
    private static string SimpleName(string cref)
    {
        var s = cref;

        // Strip the documentation-ID prefix "X:" (T:, M:, P:, F:, E:, N:, !:).
        if (s.Length > 2 && s[1] == ':') s = s.Substring(2);

        // Drop any method parameter list.
        var paren = s.IndexOf('(');
        if (paren >= 0) s = s.Substring(0, paren);

        // Take the last dotted segment.
        var dot = s.LastIndexOf('.');
        if (dot >= 0 && dot < s.Length - 1) s = s.Substring(dot + 1);

        // Strip generic arity marker (e.g. "List`1").
        var tick = s.IndexOf('`');
        if (tick >= 0) s = s.Substring(0, tick);

        return string.IsNullOrWhiteSpace(s) ? cref : s;
    }

    private static string Normalize(string raw)
    {
        // Roslyn-collected XML preserves indentation. Trim and collapse
        // surrounding whitespace into single newlines.
        var lines = raw.Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0);
        return string.Join("\n", lines);
    }
}
