# PowerShell sibling of scripts/restore-fixtures.sh — restores every e2e fixture
# project (fixtures/dotnet/**/*.csproj) without needing bash on Windows.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$fixtures = Join-Path $root 'fixtures/dotnet'
Get-ChildItem -Path $fixtures -Recurse -Filter *.csproj |
  Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' } |
  ForEach-Object {
    dotnet restore $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed for $($_.FullName)" }
  }
