#!/bin/bash
# Build the PTY native helper (tiny, no external deps)
set -e
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CC="${CC:-cc}"
CFLAGS="${CFLAGS:--O2 -Wall -Wextra}"

echo "Building pty-helper..."
"$CC" $CFLAGS -o "$SRC_DIR/src/pty-helper" "$SRC_DIR/src/pty-helper.c"
echo "Built: $SRC_DIR/src/pty-helper"
