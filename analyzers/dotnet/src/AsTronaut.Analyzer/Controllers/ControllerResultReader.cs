using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.Controllers;

public static class ControllerResultReader
{
    public static List<ResponseInfo>? TryRead(IMethodSymbol method, Compilation compilation, TypeToSchema mapper)
    {
        if (method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is not MethodDeclarationSyntax decl)
        {
            return null;
        }
        var model = compilation.GetSemanticModel(decl.SyntaxTree);

        var exprs = new List<ExpressionSyntax>();
        if (decl.ExpressionBody?.Expression is { } arrow) exprs.Add(arrow);
        if (decl.Body is { } body)
        {
            foreach (var ret in body.DescendantNodes().OfType<ReturnStatementSyntax>())
            {
                if (ret.Expression is { } e) exprs.Add(e);
            }
        }
        if (exprs.Count == 0) return null;

        var responses = new List<ResponseInfo>();
        foreach (var expr in exprs)
        {
            CollectResults(expr, model, mapper, responses);
        }
        return responses.Count > 0 ? Dedup(responses) : null;
    }

    private static void CollectResults(
        ExpressionSyntax expr, SemanticModel model, TypeToSchema mapper, List<ResponseInfo> into)
    {
        switch (expr)
        {
            case AwaitExpressionSyntax aw:
                CollectResults(aw.Expression, model, mapper, into);
                return;
            case ParenthesizedExpressionSyntax paren:
                CollectResults(paren.Expression, model, mapper, into);
                return;
            case ConditionalExpressionSyntax cond:
                CollectResults(cond.WhenTrue, model, mapper, into);
                CollectResults(cond.WhenFalse, model, mapper, into);
                return;
            case SwitchExpressionSyntax sw:
                foreach (var arm in sw.Arms) CollectResults(arm.Expression, model, mapper, into);
                return;
            case InvocationExpressionSyntax inv:
                CollectInvocation(inv, model, mapper, into);
                return;
        }
    }

    private static void CollectInvocation(
        InvocationExpressionSyntax inv, SemanticModel model, TypeToSchema mapper, List<ResponseInfo> into)
    {
        if (model.GetSymbolInfo(inv).Symbol is IMethodSymbol sym && IsControllerHelper(sym.ContainingType))
        {
            var response = HttpResultConventions.Map(sym.Name, inv, model, mapper);
            if (response is not null) into.Add(response);
            return;
        }

        foreach (var arg in inv.ArgumentList.Arguments)
        {
            if (arg.Expression is AnonymousFunctionExpressionSyntax lambda)
            {
                CollectLambdaResults(lambda, model, mapper, into);
            }
            else if (arg.Expression is IdentifierNameSyntax or MemberAccessExpressionSyntax)
            {
                CollectMethodGroup(arg.Expression, model, mapper, into);
            }
        }
    }

    private static void CollectMethodGroup(
        ExpressionSyntax expr, SemanticModel model, TypeToSchema mapper, List<ResponseInfo> into)
    {
        var info = model.GetSymbolInfo(expr);
        var sym = info.Symbol as IMethodSymbol ?? info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        if (sym is null || !IsControllerHelper(sym.ContainingType)) return;

        ITypeSymbol? valueType = null;
        if (model.GetTypeInfo(expr).ConvertedType is INamedTypeSymbol { DelegateInvokeMethod.Parameters.Length: 1 } del)
        {
            valueType = del.DelegateInvokeMethod.Parameters[0].Type;
        }

        var response = HttpResultConventions.MapMethodGroup(sym.Name, valueType, mapper);
        if (response is not null) into.Add(response);
    }

    private static void CollectLambdaResults(
        AnonymousFunctionExpressionSyntax lambda, SemanticModel model, TypeToSchema mapper, List<ResponseInfo> into)
    {
        if (lambda.ExpressionBody is { } expressionBody)
        {
            CollectResults(expressionBody, model, mapper, into);
            return;
        }
        if (lambda.Block is not { } block) return;

        var returns = block
            .DescendantNodes(n => n is not AnonymousFunctionExpressionSyntax)
            .OfType<ReturnStatementSyntax>();
        foreach (var ret in returns)
        {
            if (ret.Expression is { } e) CollectResults(e, model, mapper, into);
        }
    }

    private static bool IsControllerHelper(INamedTypeSymbol? type)
    {
        for (var t = type; t is not null; t = t.BaseType)
        {
            if (t.Name is "ControllerBase" or "Controller") return true;
        }
        return false;
    }

    private static List<ResponseInfo> Dedup(List<ResponseInfo> responses) =>
        HttpResultConventions.Dedup(responses);
}
