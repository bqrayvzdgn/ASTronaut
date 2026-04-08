package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type ParamInfo struct {
	Name     string `json:"name"`
	In       string `json:"in"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type PropertyInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type RequestBodyInfo struct {
	Type        string         `json:"type"`
	ContentType string         `json:"contentType,omitempty"`
	Properties  []PropertyInfo `json:"properties"`
}

type ResponseInfo struct {
	Status     int            `json:"status"`
	Type       *string        `json:"type"`
	Properties []PropertyInfo `json:"properties"`
}

type RouteInfo struct {
	Path        string           `json:"path"`
	Method      string           `json:"method"`
	Controller  *string          `json:"controller"`
	RoutePrefix *string          `json:"routePrefix"`
	Params      []ParamInfo      `json:"params"`
	RequestBody *RequestBodyInfo `json:"requestBody"`
	Responses   []ResponseInfo   `json:"responses"`
	Auth        *string          `json:"auth"`
	Middleware  []string         `json:"middleware"`
	Description *string          `json:"description"`
	Source      string           `json:"source"`
}

type ParseError struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

type ParseResult struct {
	Routes []RouteInfo  `json:"routes"`
	Errors []ParseError `json:"errors"`
}

var httpMethods = map[string]string{
	"GET":     "GET",
	"POST":    "POST",
	"PUT":     "PUT",
	"DELETE":  "DELETE",
	"PATCH":   "PATCH",
	"HEAD":    "HEAD",
	"OPTIONS": "OPTIONS",
	"Any":     "GET", // fallback
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: gin-analyzer <repo-path>\n")
		os.Exit(1)
	}

	repoPath := os.Args[1]
	result := ParseResult{
		Routes: []RouteInfo{},
		Errors: []ParseError{},
	}

	err := filepath.Walk(repoPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}

		// Skip common non-source directories
		base := filepath.Base(path)
		if info.IsDir() && (base == "vendor" || base == "node_modules" || base == ".git" || base == "testdata") {
			return filepath.SkipDir
		}

		// Only parse .go files, skip test files
		if !info.IsDir() && strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			routes, errors := parseGoFile(path, repoPath)
			result.Routes = append(result.Routes, routes...)
			result.Errors = append(result.Errors, errors...)
		}

		return nil
	})

	if err != nil {
		result.Errors = append(result.Errors, ParseError{
			File:   repoPath,
			Reason: fmt.Sprintf("Failed to walk directory: %s", err),
		})
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}

func parseGoFile(filePath string, repoPath string) ([]RouteInfo, []ParseError) {
	var routes []RouteInfo
	var errors []ParseError

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filePath, nil, parser.ParseComments)
	if err != nil {
		errors = append(errors, ParseError{
			File:   relativePath(filePath, repoPath),
			Reason: fmt.Sprintf("Parse error: %s", err),
		})
		return routes, errors
	}

	// Track gin engine/group variables and their prefixes
	// key: variable name, value: prefix path
	groupPrefixes := map[string]string{}

	ast.Inspect(node, func(n ast.Node) bool {
		// Look for method calls like r.GET("/path", handler)
		callExpr, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}

		selExpr, ok := callExpr.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		methodName := selExpr.Sel.Name

		// Check for Group() calls: v1 := r.Group("/api/v1")
		if methodName == "Group" && len(callExpr.Args) > 0 {
			if groupPath := extractStringLiteral(callExpr.Args[0]); groupPath != "" {
				// Try to find the assignment target
				// This is a simplification — works for `v1 := r.Group("/prefix")`
				// tracked via parent assignment
				_ = groupPath // Will be picked up in assignment tracking below
			}
			return true
		}

		// Check if this is an HTTP method registration
		httpMethod, isHTTP := httpMethods[methodName]
		if !isHTTP {
			return true
		}

		// Extract path argument
		if len(callExpr.Args) < 2 {
			return true
		}

		routePath := extractStringLiteral(callExpr.Args[0])
		if routePath == "" {
			return true
		}

		// Determine prefix from receiver variable
		prefix := ""
		if ident, ok := selExpr.X.(*ast.Ident); ok {
			if p, exists := groupPrefixes[ident.Name]; exists {
				prefix = p
			}
		}

		fullPath := prefix + routePath

		// Extract path params (e.g., :id, *action)
		params := extractPathParams(fullPath)

		// Extract handler name for description
		var description *string
		if len(callExpr.Args) >= 2 {
			lastArg := callExpr.Args[len(callExpr.Args)-1]
			if handlerName := extractFuncName(lastArg); handlerName != "" {
				desc := handlerName
				description = &desc
			}
		}

		// Extract middleware (args between path and handler)
		var middleware []string
		if len(callExpr.Args) > 2 {
			for _, arg := range callExpr.Args[1 : len(callExpr.Args)-1] {
				if mwName := extractFuncName(arg); mwName != "" {
					middleware = append(middleware, mwName)
				}
			}
		}

		// Detect auth middleware
		var auth *string
		for _, mw := range middleware {
			lower := strings.ToLower(mw)
			if strings.Contains(lower, "auth") || strings.Contains(lower, "jwt") || strings.Contains(lower, "token") {
				auth = &mw
				break
			}
		}

		route := RouteInfo{
			Path:        convertGinPathToOpenAPI(fullPath),
			Method:      httpMethod,
			Controller:  nil,
			RoutePrefix: nilIfEmpty(prefix),
			Params:      params,
			RequestBody: nil,
			Responses:   []ResponseInfo{{Status: 200, Type: nil, Properties: []PropertyInfo{}}},
			Auth:        auth,
			Middleware:   ensureSlice(middleware),
			Description: description,
			Source:      relativePath(filePath, repoPath),
		}

		routes = append(routes, route)
		return true
	})

	// Second pass: track Group() assignments
	ast.Inspect(node, func(n ast.Node) bool {
		assignStmt, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}

		if len(assignStmt.Rhs) != 1 || len(assignStmt.Lhs) != 1 {
			return true
		}

		callExpr, ok := assignStmt.Rhs[0].(*ast.CallExpr)
		if !ok {
			return true
		}

		selExpr, ok := callExpr.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		if selExpr.Sel.Name != "Group" || len(callExpr.Args) == 0 {
			return true
		}

		groupPath := extractStringLiteral(callExpr.Args[0])
		if groupPath == "" {
			return true
		}

		// Get parent prefix if receiver is a known group
		parentPrefix := ""
		if ident, ok := selExpr.X.(*ast.Ident); ok {
			if p, exists := groupPrefixes[ident.Name]; exists {
				parentPrefix = p
			}
		}

		// Get the assigned variable name
		if ident, ok := assignStmt.Lhs[0].(*ast.Ident); ok {
			groupPrefixes[ident.Name] = parentPrefix + groupPath
		}

		return true
	})

	// If we found group prefixes, re-parse to get routes with correct prefixes
	if len(groupPrefixes) > 0 {
		routes = nil // Reset and re-parse with prefix info
		ast.Inspect(node, func(n ast.Node) bool {
			callExpr, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}

			selExpr, ok := callExpr.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}

			methodName := selExpr.Sel.Name
			httpMethod, isHTTP := httpMethods[methodName]
			if !isHTTP || methodName == "Group" {
				return true
			}

			if len(callExpr.Args) < 2 {
				return true
			}

			routePath := extractStringLiteral(callExpr.Args[0])
			if routePath == "" {
				return true
			}

			prefix := ""
			if ident, ok := selExpr.X.(*ast.Ident); ok {
				if p, exists := groupPrefixes[ident.Name]; exists {
					prefix = p
				}
			}

			fullPath := prefix + routePath
			params := extractPathParams(fullPath)

			var description *string
			if len(callExpr.Args) >= 2 {
				lastArg := callExpr.Args[len(callExpr.Args)-1]
				if handlerName := extractFuncName(lastArg); handlerName != "" {
					desc := handlerName
					description = &desc
				}
			}

			var middleware []string
			if len(callExpr.Args) > 2 {
				for _, arg := range callExpr.Args[1 : len(callExpr.Args)-1] {
					if mwName := extractFuncName(arg); mwName != "" {
						middleware = append(middleware, mwName)
					}
				}
			}

			var auth *string
			for _, mw := range middleware {
				lower := strings.ToLower(mw)
				if strings.Contains(lower, "auth") || strings.Contains(lower, "jwt") || strings.Contains(lower, "token") {
					auth = &mw
					break
				}
			}

			route := RouteInfo{
				Path:        convertGinPathToOpenAPI(fullPath),
				Method:      httpMethod,
				Controller:  nil,
				RoutePrefix: nilIfEmpty(prefix),
				Params:      params,
				RequestBody: nil,
				Responses:   []ResponseInfo{{Status: 200, Type: nil, Properties: []PropertyInfo{}}},
				Auth:        auth,
				Middleware:   ensureSlice(middleware),
				Description: description,
				Source:      relativePath(filePath, repoPath),
			}

			routes = append(routes, route)
			return true
		})
	}

	return routes, errors
}

func extractStringLiteral(expr ast.Expr) string {
	if lit, ok := expr.(*ast.BasicLit); ok && lit.Kind == token.STRING {
		// Remove quotes
		return strings.Trim(lit.Value, `"` + "`")
	}
	return ""
}

func extractFuncName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		if ident, ok := e.X.(*ast.Ident); ok {
			return ident.Name + "." + e.Sel.Name
		}
		return e.Sel.Name
	case *ast.CallExpr:
		return extractFuncName(e.Fun)
	}
	return ""
}

// Convert Gin path params to OpenAPI format: :id → {id}, *action → {action}
func convertGinPathToOpenAPI(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, ":") {
			parts[i] = "{" + part[1:] + "}"
		} else if strings.HasPrefix(part, "*") {
			parts[i] = "{" + part[1:] + "}"
		}
	}
	return strings.Join(parts, "/")
}

func extractPathParams(path string) []ParamInfo {
	var params []ParamInfo
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if strings.HasPrefix(part, ":") {
			params = append(params, ParamInfo{
				Name:     part[1:],
				In:       "path",
				Type:     "string",
				Required: true,
			})
		} else if strings.HasPrefix(part, "*") {
			params = append(params, ParamInfo{
				Name:     part[1:],
				In:       "path",
				Type:     "string",
				Required: true,
			})
		}
	}
	if params == nil {
		params = []ParamInfo{}
	}
	return params
}

func relativePath(filePath, basePath string) string {
	rel, err := filepath.Rel(basePath, filePath)
	if err != nil {
		return filePath
	}
	return filepath.ToSlash(rel)
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func ensureSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
