@echo off
setlocal
chcp 65001 >nul 2>&1

:: ============================================================
:: Init Wiki - model download
:: Usage:
::   init-wiki-model.bat [model-id] [--url URL] [--proxy PROXY]
::   init-wiki-model.bat --help
::
:: Examples:
::   init-wiki-model.bat
::   init-wiki-model.bat paraphrase-multilingual
::   init-wiki-model.bat --url https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main
::   init-wiki-model.bat --proxy http://127.0.0.1:10900
::   init-wiki-model.bat --url https://my-mirror.com/models --proxy http://127.0.0.1:7890
:: ============================================================

set MODEL_ID=bge-base-zh-v1.5
set CUSTOM_URL=
set PROXY=

:: ===== Parse arguments =====
:parse
if "%~1"=="" goto :done_parse
if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if /i "%~1"=="--url" (
    set CUSTOM_URL=%~2
    shift
    shift
    goto :parse
)
if /i "%~1"=="-u" (
    set CUSTOM_URL=%~2
    shift
    shift
    goto :parse
)
if /i "%~1"=="--proxy" (
    set PROXY=%~2
    shift
    shift
    goto :parse
)
if /i "%~1"=="-p" (
    set PROXY=%~2
    shift
    shift
    goto :parse
)
:: First non-flag argument = model-id
set MODEL_ID=%~1
shift
goto :parse

:help
echo Usage: init-wiki-model.bat [model-id] [--url URL] [--proxy PROXY]
echo.
echo   model-id   bge-base-zh-v1.5 (default) ^| bge-large-zh-v1.5 ^| paraphrase-multilingual ^| bge-m3
echo   --url -u    Custom download base URL (replaces hf-mirror.com)
echo   --proxy -p  Proxy server (e.g. http://127.0.0.1:7890)
echo   --help -h   Show this help
echo.
echo Examples:
echo   init-wiki-model.bat
echo   init-wiki-model.bat paraphrase-multilingual
echo   init-wiki-model.bat --url https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main
echo   init-wiki-model.bat --proxy http://127.0.0.1:10900
echo   init-wiki-model.bat --url https://my-mirror.com/models --proxy http://127.0.0.1:7890
echo.
echo Default mirror: https://hf-mirror.com
echo Note: --url should point to the directory containing config.json etc.
echo       (e.g. https://example.com/Xenova/bge-base-zh-v1.5/resolve/main)
exit /b 0

:done_parse

:: ===== Map model id to repo & dirname =====
if /i "%MODEL_ID%"=="bge-base-zh-v1.5" (
    set REPO=Xenova/bge-base-zh-v1.5
    set DIRNAME=bge-base-zh-v1.5
    set ONNX_SIZE=~130 MB
) else if /i "%MODEL_ID%"=="paraphrase-multilingual" (
    set REPO=Xenova/paraphrase-multilingual-MiniLM-L12-v2
    set DIRNAME=paraphrase-multilingual-MiniLM-L12-v2
    set ONNX_SIZE=~118 MB
) else if /i "%MODEL_ID%"=="bge-large-zh-v1.5" (
    set REPO=Xenova/bge-large-zh-v1.5
    set DIRNAME=bge-large-zh-v1.5
    set ONNX_SIZE=~324 MB
) else if /i "%MODEL_ID%"=="bge-m3" (
    set REPO=Xenova/bge-m3
    set DIRNAME=bge-m3
    set ONNX_SIZE=~340 MB
) else (
    echo [ERROR] Unknown model: %MODEL_ID%
    echo Available: bge-base-zh-v1.5 ^| bge-large-zh-v1.5 ^| paraphrase-multilingual ^| bge-m3
    exit /b 1
)

:: ===== Build download URL =====
if defined CUSTOM_URL (
    :: Strip trailing slash if present
    if "%CUSTOM_URL:~-1%"=="/" set CUSTOM_URL=%CUSTOM_URL:~0,-1%
    set BASE_URL=%CUSTOM_URL%
    echo [INFO] Using custom URL: %BASE_URL%
) else (
    set BASE_URL=https://hf-mirror.com/%REPO%/resolve/main
    echo [INFO] Using default mirror: hf-mirror.com
)

:: ===== Build curl options =====
set CURL_OPTS=-L -f --progress-bar --retry 3 --connect-timeout 30
if defined PROXY (
    set CURL_OPTS=%CURL_OPTS% --proxy %PROXY%
    echo [INFO] Using proxy: %PROXY%
)

:: ===== Paths =====
set DIR=%USERPROFILE%\.pi\agent\extensions\wiki
set MODELDIR=%DIR%\models\%DIRNAME%

echo.
echo === Download model files ===
echo    Model: %MODEL_ID% (%REPO%)
echo    Dir: %MODELDIR%
echo    Base URL: %BASE_URL%
echo.

mkdir "%MODELDIR%\onnx" 2>nul

echo [1/4] config.json
curl %CURL_OPTS% -o "%MODELDIR%\config.json" "%BASE_URL%/config.json" || (
    echo [ERROR] Failed to download config.json
    exit /b 1
)

echo [2/4] tokenizer_config.json
curl %CURL_OPTS% -o "%MODELDIR%\tokenizer_config.json" "%BASE_URL%/tokenizer_config.json" || (
    echo [ERROR] Failed to download tokenizer_config.json
    exit /b 1
)

echo [3/4] tokenizer.json (~16 MB)
curl %CURL_OPTS% -o "%MODELDIR%\tokenizer.json" "%BASE_URL%/tokenizer.json" || (
    echo [ERROR] Failed to download tokenizer.json
    exit /b 1
)

echo [4/4] onnx/model_quantized.onnx (%ONNX_SIZE%)
curl %CURL_OPTS% -o "%MODELDIR%\onnx\model_quantized.onnx" "%BASE_URL%/onnx/model_quantized.onnx" || (
    echo [ERROR] Failed to download model_quantized.onnx
    exit /b 1
)

echo.
echo === Model download complete ===
echo    %MODELDIR%
echo.
