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

:: Write package.json with all dependencies (single source of truth)
powershell -NoProfile -Command "Set-Content -Encoding UTF8 '%DIR%\package.json' -Value '{\"name\":\"pi-wiki\",\"private\":true,\"type\":\"module\",\"description\":\"Pi Wiki - semantic KB subsystem\",\"dependencies\":{\"@huggingface/transformers\":\"^3.0.0\",\"unified\":\"^11.0.0\",\"remark-parse\":\"^11.0.0\",\"unist-util-visit\":\"^5.0.0\"}}'"

pushd "%DIR%" || (echo ERROR: cannot access %DIR% & exit /b 1)
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    popd
    exit /b 1
)
popd

echo.
echo OK: all dependencies installed
echo.
