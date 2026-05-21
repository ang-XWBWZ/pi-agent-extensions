#!/usr/bin/env bash
# ============================================================
# Init Wiki - npm dependencies
# ============================================================
set -euo pipefail

WIKI="$HOME/.pi/agent/extensions/wiki"

echo "=== Install npm dependencies ==="
echo "    Dir: $WIKI"
echo ""

# Write package.json with all dependencies (single source of truth)
cat > "$WIKI/package.json" << 'JSONEOF'
{
  "name": "pi-wiki",
  "private": true,
  "description": "Pi Wiki — 语义知识库子系统",
  "dependencies": {
    "@huggingface/transformers": "^3.0.0",
    "unified": "^11.0.0",
    "remark-parse": "^11.0.0",
    "unist-util-visit": "^5.0.0"
  }
}
JSONEOF

cd "$WIKI"
npm install

echo ""
echo "OK: all dependencies installed"
