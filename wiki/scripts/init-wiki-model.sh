#!/usr/bin/env bash
# ============================================================
# Init Wiki - model download
# Usage:
#   ./init-wiki-model.sh [model-id] [int8|fp32] [-u URL] [-p PROXY]
#   ./init-wiki-model.sh --help
#
# Examples:
#   ./init-wiki-model.sh
#   ./init-wiki-model.sh paraphrase-multilingual
#   ./init-wiki-model.sh -u https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main
#   ./init-wiki-model.sh -p http://127.0.0.1:10900
#   ./init-wiki-model.sh -u https://my-mirror.com/models -p http://127.0.0.1:7890
# ============================================================
set -euo pipefail

MODEL_ID="bge-base-zh-v1.5"
VARIANT="int8"
CUSTOM_URL=""
PROXY=""

show_help() {
    cat <<EOF
Usage: ./init-wiki-model.sh [model-id] [int8|fp32] [-u URL] [-p PROXY]

  model-id   bge-base-zh-v1.5 (default) | paraphrase-multilingual
  int8|fp32  Quantization variant (default: int8)
  -u --url   Custom download base URL (replaces hf-mirror.com)
  -p --proxy Proxy server (e.g. http://127.0.0.1:7890)
  -h --help  Show this help

Examples:
  ./init-wiki-model.sh
  ./init-wiki-model.sh paraphrase-multilingual
  ./init-wiki-model.sh -u https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main
  ./init-wiki-model.sh -p http://127.0.0.1:10900
  ./init-wiki-model.sh -u https://my-mirror.com/models -p http://127.0.0.1:7890

Default mirror: https://hf-mirror.com
Note: --url should point to the directory containing config.json etc.
      (e.g. https://example.com/Xenova/bge-base-zh-v1.5/resolve/main)
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -u|--url)
            CUSTOM_URL="${2%/}"   # strip trailing slash
            shift 2
            ;;
        -p|--proxy)
            PROXY="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        int8|fp32)
            VARIANT="$1"
            shift
            ;;
        *)
            MODEL_ID="$1"
            shift
            ;;
    esac
done

# Map model id -> repo + dirname + sizes
case "$MODEL_ID" in
  bge-base-zh-v1.5)
    REPO="Xenova/bge-base-zh-v1.5"
    DIRNAME="bge-base-zh-v1.5"
    INT8_SIZE="~130 MB"
    FP32_SIZE="~390 MB"
    ;;
  paraphrase-multilingual)
    REPO="Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    DIRNAME="paraphrase-multilingual-MiniLM-L12-v2"
    INT8_SIZE="~118 MB"
    FP32_SIZE="~470 MB"
    ;;
  bge-large-zh-v1.5)
    REPO="Xenova/bge-large-zh-v1.5"
    DIRNAME="bge-large-zh-v1.5"
    INT8_SIZE="~324 MB"
    FP32_SIZE="~1.3 GB"
    ;;
  bge-m3)
    REPO="Xenova/bge-m3"
    DIRNAME="bge-m3"
    INT8_SIZE="~340 MB"
    FP32_SIZE="~2.2 GB"
    ;;
  *)
    echo "[ERROR] Unknown model: $MODEL_ID"
    echo "Available: bge-base-zh-v1.5 | bge-large-zh-v1.5 | paraphrase-multilingual | bge-m3"
    exit 1
    ;;
esac

# Paths
WIKI="$HOME/.pi/agent/extensions/wiki"
MODELDIR="$WIKI/models/$DIRNAME"
ONNXDIR="$MODELDIR/onnx"

# Build download URL
if [ -n "$CUSTOM_URL" ]; then
    BASE_URL="$CUSTOM_URL"
    echo "[INFO] Using custom URL: $BASE_URL"
else
    BASE_URL="https://hf-mirror.com/${REPO}/resolve/main"
    echo "[INFO] Using default mirror: hf-mirror.com"
fi

if [ -n "$PROXY" ]; then
    echo "[INFO] Using proxy: $PROXY"
fi

# Build curl options
CURL_OPTS="-L -f --progress-bar --retry 3 --connect-timeout 30"
if [ -n "$PROXY" ]; then
    CURL_OPTS="$CURL_OPTS --proxy $PROXY"
fi

# Select ONNX file
if [ "$VARIANT" = "fp32" ]; then
    ONNX_SIZE="$FP32_SIZE"
    ONNX_FILE="onnx/model.onnx"
else
    ONNX_SIZE="$INT8_SIZE"
    ONNX_FILE="onnx/model_quantized.onnx"
fi

echo ""
echo "=== Download model files ==="
echo "    Model: $MODEL_ID ($REPO)"
echo "    Dir: $MODELDIR"
echo "    Variant: $VARIANT"
echo "    Base URL: $BASE_URL"
echo ""

mkdir -p "$ONNXDIR"

download() {
    local name="$1" size="$2" n="$3"
    echo "[$n/4] $name ($size)"
    if ! curl $CURL_OPTS -o "$MODELDIR/$name" "$BASE_URL/$name"; then
        echo "[ERROR] Failed to download $name"
        echo "        URL: $BASE_URL/$name"
        exit 1
    fi
}

download "config.json"           "~1 KB"   1
download "tokenizer_config.json" "~1 KB"   2
download "tokenizer.json"        "~16 MB"  3
download "$ONNX_FILE"            "$ONNX_SIZE" 4

echo ""
echo "=== Model download complete ==="
echo "    $MODELDIR"
