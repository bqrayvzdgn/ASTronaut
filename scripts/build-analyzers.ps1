# PowerShell sibling of scripts/build-analyzers.sh — Windows-native build path
# that avoids the bash dependency for Windows-only developers.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$proj = Join-Path $root 'analyzers/dotnet/src/AsTronaut.Analyzer/AsTronaut.Analyzer.csproj'
$dist = Join-Path $root 'analyzers/dotnet/dist'

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
dotnet publish $proj -c Release -o $dist
Write-Host "Built: $dist\AsTronaut.Analyzer.dll"
