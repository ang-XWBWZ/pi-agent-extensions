<#
.SYNOPSIS
  Init Wiki - model download
.DESCRIPTION
  Download an embedding model from HuggingFace mirror (or custom URL).
.PARAMETER ModelId
  bge-base-zh-v1.5 (default) | paraphrase-multilingual
.PARAMETER Variant
  int8 (default) | fp32
.PARAMETER Url
  Custom download base URL. Replaces the default hf-mirror.com.
  Should point to the directory containing config.json etc.
  (e.g. https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main)
.PARAMETER Proxy
  Proxy server (e.g. http://127.0.0.1:7890)
.EXAMPLE
  .\init-wiki-model.ps1
  .\init-wiki-model.ps1 -ModelId paraphrase-multilingual
  .\init-wiki-model.ps1 -Url https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main
  .\init-wiki-model.ps1 -Proxy http://127.0.0.1:10900
  .\init-wiki-model.ps1 -Url https://my-mirror.com/models -Proxy http://127.0.0.1:7890
#>

param(
    [ValidateSet("bge-base-zh-v1.5", "bge-large-zh-v1.5", "paraphrase-multilingual", "bge-m3")]
    [string]$ModelId = "bge-base-zh-v1.5",

    [ValidateSet("int8", "fp32")]
    [string]$Variant = "int8",

    [string]$Url,

    [string]$Proxy
)

$ErrorActionPreference = "Stop"

# Map model id -> HuggingFace repo name + sizes
$modelMap = @{
    "bge-base-zh-v1.5"        = @{
        repo    = "Xenova/bge-base-zh-v1.5"
        dirName = "bge-base-zh-v1.5"
        int8    = "~130 MB"
        fp32    = "~390 MB"
    }
    "bge-large-zh-v1.5"       = @{
        repo    = "Xenova/bge-large-zh-v1.5"
        dirName = "bge-large-zh-v1.5"
        int8    = "~324 MB"
        fp32    = "~1.3 GB"
    }
    "paraphrase-multilingual" = @{
        repo    = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
        dirName = "paraphrase-multilingual-MiniLM-L12-v2"
        int8    = "~118 MB"
        fp32    = "~470 MB"
    }
    "bge-m3"                   = @{
        repo    = "Xenova/bge-m3"
        dirName = "bge-m3"
        int8    = "~340 MB"
        fp32    = "~2.2 GB"
    }
}

$info      = $modelMap[$ModelId]
$WikiDir   = Join-Path "$env:USERPROFILE\.pi\agent\extensions" "wiki"
$modelDir  = Join-Path $WikiDir "models" $info.dirName
$onnxDir   = Join-Path $modelDir "onnx"

# Build download URL
if ($Url) {
    $baseUrl = $Url.TrimEnd('/')
    Write-Host "[INFO] Using custom URL: $baseUrl" -ForegroundColor DarkGray
} else {
    $baseUrl = "https://hf-mirror.com/$($info.repo)/resolve/main"
    Write-Host "[INFO] Using default mirror: hf-mirror.com" -ForegroundColor DarkGray
}

if ($Proxy) {
    Write-Host "[INFO] Using proxy: $Proxy" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Download model files ===" -ForegroundColor Cyan
Write-Host "    Model: $ModelId ($($info.repo))" -ForegroundColor Cyan
Write-Host "    Dir: $modelDir" -ForegroundColor Cyan
Write-Host "    Variant: $Variant" -ForegroundColor Cyan
Write-Host "    Base URL: $baseUrl" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $onnxDir | Out-Null

$files = @(
    @{Name="config.json";           Size="~1 KB"},
    @{Name="tokenizer_config.json"; Size="~1 KB"},
    @{Name="tokenizer.json";        Size="~16 MB"}
)

if ($Variant -eq "int8") {
    $files += @{Name="onnx/model_quantized.onnx"; Size=$info.int8}
} else {
    $files += @{Name="onnx/model.onnx"; Size=$info.fp32}
}

$total = $files.Count
$i = 0
$maxRetries = 3

foreach ($f in $files) {
    $i++
    $url  = "$baseUrl/$($f.Name)"
    $out  = Join-Path $modelDir $f.Name
    $outDir = Split-Path -Parent $out
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    Write-Host "[$i/$total] $($f.Name) ($($f.Size)) " -NoNewline

    $success = $false
    for ($retry = 1; $retry -le $maxRetries; $retry++) {
        try {
            $iwrParams = @{
                Uri             = $url
                OutFile         = $out
                ErrorAction     = 'Stop'
                TimeoutSec      = 60
                MaximumRetryCount = 1
            }
            if ($Proxy) {
                $iwrParams.Proxy = $Proxy
            }
            if ($retry -gt 1) {
                Write-Host "[retry $retry/$maxRetries] " -NoNewline
            }
            Invoke-WebRequest @iwrParams
            $success = $true
            break
        } catch {
            if ($retry -lt $maxRetries) {
                Start-Sleep -Seconds 2
            }
        }
    }

    if ($success) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        Write-Host "FAIL" -ForegroundColor Red
        Write-Host "       URL: $url" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "=== Model download complete ===" -ForegroundColor Green
Write-Host "    $modelDir"
