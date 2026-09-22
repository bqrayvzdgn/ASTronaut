#!/usr/bin/env bash
# Restores every e2e fixture project (fixtures/dotnet/**/*.csproj) so
# MSBuildWorkspace can load them on a fresh checkout — obj/ is gitignored.
# Solutions need no separate step: restoring each .csproj covers them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
find "$ROOT/fixtures/dotnet" -name '*.csproj' -not -path '*/bin/*' -not -path '*/obj/*' -print0 \
  | xargs -0 -n1 dotnet restore
