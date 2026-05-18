#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/analyzers/dotnet/src/AsTronaut.Analyzer/AsTronaut.Analyzer.csproj"
DIST="$ROOT/analyzers/dotnet/dist"
rm -rf "$DIST"
dotnet publish "$PROJ" -c Release -o "$DIST"
echo "Built: $DIST/AsTronaut.Analyzer.dll"
