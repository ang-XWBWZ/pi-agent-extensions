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

# Ensure package.json exists (anchors npm to this directory)
$pkgJson = Join-Path $WikiDir "package.json"
if (-not (Test-Path $pkgJson)) {
    '{"name":"pi-wiki","private":true}' | Out-File -FilePath $pkgJson -Encoding utf8
}

Push-Location $WikiDir
try {
    npm install @huggingface/transformers
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed (exit $LASTEXITCODE)"
    }
    Write-Host ""
    Write-Host "OK: @huggingface/transformers installed" -ForegroundColor Green
} finally {
    Pop-Location
}
