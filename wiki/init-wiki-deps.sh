#!/usr/bin/env bash
# ============================================================
# Init Wiki - npm dependencies
# ============================================================
set -euo pipefail

WIKI="$HOME/.pi/agent/extensions/wiki"

echo "=== Install npm dependencies ==="
echo "    Dir: $WIKI"
echo ""

# Ensure package.json exists (anchors npm to this directory)
if [ ! -f "$WIKI/package.json" ]; then
    echo '{"name":"pi-wiki","private":true}' > "$WIKI/package.json"
fi

cd "$WIKI"
npm install @huggingface/transformers

echo ""
echo "OK: @huggingface/transformers installed"
