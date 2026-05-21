<#
.SYNOPSIS
  Init Wiki - npm dependencies
.DESCRIPTION
  Install @huggingface/transformers into ~/.pi/agent/extensions/wiki/node_modules/
#>

$ErrorActionPreference = "Stop"
$WikiDir = Join-Path "$env:USERPROFILE\.pi\agent\extensions" "wiki"

Write-Host "=== Install npm dependencies ===" -ForegroundColor Cyan
Write-Host "    Dir: $WikiDir" -ForegroundColor Cyan
Write-Host ""

# Write package.json with all dependencies (single source of truth)
$pkgJson = Join-Path $WikiDir "package.json"
@'
{
  "name": "pi-wiki",
  "private": true,
  "description": "Pi Wiki — 语义知识库子系统",
  "dependencies": {
    "@huggingface/transformers": "^3.0.0",
    "unified": "^11.0.0",
    "remark-parse": "^11.0.0",
    "unist-util-visit": "^5.0.0"
  }
}
'@ | Out-File -FilePath $pkgJson -Encoding utf8

Push-Location $WikiDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed (exit $LASTEXITCODE)"
    }
    Write-Host ""
    Write-Host "OK: all dependencies installed" -ForegroundColor Green
} finally {
    Pop-Location
}
