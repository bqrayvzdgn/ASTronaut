using System.Globalization;
using System.Text;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

public sealed class XmlDocReader
{
    public string? Summary { get; }
    public string? Description { get; }
    public IReadOnlyDictionary<string, string> Params { get; }
    public string? Returns { get; }

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
                AppendChildren(sb, e);
                break;
        }
    }

    private static string SimpleName(string cref)
    {
        var s = cref;

        if (s.Length > 2 && s[1] == ':') s = s.Substring(2);

        var paren = s.IndexOf('(');
        if (paren >= 0) s = s.Substring(0, paren);

        var dot = s.LastIndexOf('.');
        if (dot >= 0 && dot < s.Length - 1) s = s.Substring(dot + 1);

        var tick = s.IndexOf('`');
        if (tick >= 0) s = s.Substring(0, tick);

        return string.IsNullOrWhiteSpace(s) ? cref : s;
    }

    private static string Normalize(string raw)
    {
        var lines = raw.Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0);
        return string.Join("\n", lines);
    }
}
