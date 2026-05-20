@echo off
setlocal
chcp 65001 >nul 2>&1

:: ============================================================
:: Init Wiki - model download
:: ============================================================

set DIR=%USERPROFILE%\.pi\agent\extensions\wiki
set MODEL=paraphrase-multilingual-MiniLM-L12-v2
set MIRROR=https://hf-mirror.com/Xenova/%MODEL%/resolve/main
set MODELDIR=%DIR%\models\%MODEL%

echo === Download model files ===
echo    Dir: %MODELDIR%
echo.

mkdir "%MODELDIR%\onnx" 2>nul

echo [1/4] config.json
curl -L -f -o "%MODELDIR%\config.json" "%MIRROR%/config.json" --progress-bar || exit /b 1

echo [2/4] tokenizer_config.json
curl -L -f -o "%MODELDIR%\tokenizer_config.json" "%MIRROR%/tokenizer_config.json" --progress-bar || exit /b 1

echo [3/4] tokenizer.json (~16 MB)
curl -L -f -o "%MODELDIR%\tokenizer.json" "%MIRROR%/tokenizer.json" --progress-bar || exit /b 1

echo [4/4] onnx/model_quantized.onnx (~118 MB)
curl -L -f -o "%MODELDIR%\onnx\model_quantized.onnx" "%MIRROR%/onnx/model_quantized.onnx" --progress-bar || exit /b 1

echo.
echo === Model download complete ===
echo    %MODELDIR%
echo.
