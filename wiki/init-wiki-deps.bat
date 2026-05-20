@echo off
setlocal
chcp 65001 >nul 2>&1

:: ============================================================
:: Init Wiki - npm dependencies
:: ============================================================

set DIR=%USERPROFILE%\.pi\agent\extensions\wiki

echo === Install npm dependencies ===
echo    Dir: %DIR%
echo.

:: Ensure package.json exists (anchors npm to this directory)
if not exist "%DIR%\package.json" (
    echo {"name":"pi-wiki","private":true} > "%DIR%\package.json"
)

pushd "%DIR%" || (echo ERROR: cannot access %DIR% & exit /b 1)
call npm install @huggingface/transformers
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    popd
    exit /b 1
)
popd

echo.
echo OK: @huggingface/transformers installed
echo.
