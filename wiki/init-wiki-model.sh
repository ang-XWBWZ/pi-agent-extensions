#!/usr/bin/env bash
# ============================================================
# Init Wiki - model download
# Usage: ./init-wiki-model.sh [int8|fp32]
# ============================================================
set -euo pipefail

VARIANT="${1:-int8}"
WIKI="$HOME/.pi/agent/extensions/wiki"
MODEL="paraphrase-multilingual-MiniLM-L12-v2"
MIRROR="https://hf-mirror.com/Xenova/${MODEL}/resolve/main"
MODELDIR="$WIKI/models/$MODEL"
ONNXDIR="$MODELDIR/onnx"

echo "=== Download model files ==="
echo "    Dir: $MODELDIR"
echo "    Variant: $VARIANT"
echo ""

mkdir -p "$ONNXDIR"

download() {
    local name="$1" size="$2" n="$3"
    echo "[$n/4] $name ($size)"
    curl -L -f -o "$MODELDIR/$name" "$MIRROR/$name" --progress-bar || {
        echo "FAIL: $name"
        exit 1
    }
}

download "config.json"           "~1 KB"   1
download "tokenizer_config.json" "~1 KB"   2
download "tokenizer.json"        "~16 MB"  3

if [ "$VARIANT" = "fp32" ]; then
    download "onnx/model.onnx"           "~470 MB" 4
else
    download "onnx/model_quantized.onnx" "~118 MB" 4
fi

echo ""
echo "=== Model download complete ==="
echo "    $MODELDIR"
