<#
.SYNOPSIS
  Init Wiki - model download
.DESCRIPTION
  Download paraphrase-multilingual-MiniLM-L12-v2 from HuggingFace mirror.
.PARAMETER Variant
  int8 (default, ~118MB) | fp32 (~470MB)
#>

param(
    [ValidateSet("int8", "fp32")]
    [string]$Variant = "int8"
)

$ErrorActionPreference = "Stop"
$WikiDir   = Join-Path "$env:USERPROFILE\.pi\agent\extensions" "wiki"
$modelName = "paraphrase-multilingual-MiniLM-L12-v2"
$modelDir  = Join-Path $WikiDir "models" $modelName
$onnxDir   = Join-Path $modelDir "onnx"
$mirror    = "https://hf-mirror.com/Xenova/$modelName/resolve/main"

Write-Host "=== Download model files ===" -ForegroundColor Cyan
Write-Host "    Dir: $modelDir" -ForegroundColor Cyan
Write-Host "    Variant: $Variant" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $onnxDir | Out-Null

$files = @(
    @{Name="config.json";           Size="~1 KB"},
    @{Name="tokenizer_config.json"; Size="~1 KB"},
    @{Name="tokenizer.json";        Size="~16 MB"}
)

if ($Variant -eq "int8") {
    $files += @{Name="onnx/model_quantized.onnx"; Size="~118 MB"}
} else {
    $files += @{Name="onnx/model.onnx"; Size="~470 MB"}
}

$total = $files.Count
$i = 0
foreach ($f in $files) {
    $i++
    $url  = "$mirror/$($f.Name)"
    $out  = Join-Path $modelDir $f.Name
    $outDir = Split-Path -Parent $out
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    Write-Host "[$i/$total] $($f.Name) ($($f.Size)) " -NoNewline
    try {
        Invoke-WebRequest -Uri $url -OutFile $out -ErrorAction Stop
        Write-Host "OK" -ForegroundColor Green
    } catch {
        Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "=== Model download complete ===" -ForegroundColor Green
Write-Host "    $modelDir"
