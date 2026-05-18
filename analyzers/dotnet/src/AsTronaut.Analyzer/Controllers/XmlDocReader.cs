using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Reads XML documentation comments off a Roslyn ISymbol via
// GetDocumentationCommentXml(). Returns the <summary> text and a per-parameter
// map of <param name="..."> text. Implementation is defensive: malformed XML
// returns empty results rather than throwing.
public sealed class XmlDocReader
{
    public string? Summary { get; }
    public string? Description { get; }
    public IReadOnlyDictionary<string, string> Params { get; }
    public string? Returns { get; }

    private static readonly IReadOnlyDictionary<string, string> EmptyParams =
        new Dictionary<string, string>();

    private XmlDocReader(string? summary, string? description, Dictionary<string, string> @params, string? returns)
    {
        Summary = summary;
        Description = description;
        Params = @params;
        Returns = returns;
    }

    public static XmlDocReader From(ISymbol symbol)
    {
        var xml = symbol.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml))
        {
            return new XmlDocReader(null, null, new Dictionary<string, string>(), null);
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
                var text = Normalize(p.Value);
                if (!string.IsNullOrWhiteSpace(text)) paramMap[name] = text;
            }
            return new XmlDocReader(summary, remarks, paramMap, returns);
        }
        catch
        {
            return new XmlDocReader(null, null, new Dictionary<string, string>(), null);
        }
    }

    public static XmlDocReader Empty() => new(null, null, new Dictionary<string, string>(), null);

    private static string? ReadElement(XDocument doc, string name)
    {
        var el = doc.Descendants(name).FirstOrDefault();
        if (el is null) return null;
        var text = Normalize(el.Value);
        return string.IsNullOrWhiteSpace(text) ? null : text;
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
