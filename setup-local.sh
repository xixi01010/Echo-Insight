#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIRECTORY_NAME=$(printf '02_\345\267\245\347\250\213\344\273\243\347\240\201')
cd "$SCRIPT_DIR/$PROJECT_DIRECTORY_NAME"

if ! command -v node >/dev/null 2>&1; then
  echo "[Echo Insight] Node.js was not found. Install Node.js 20.19+ or 22.12+ first." >&2
  exit 1
fi

exec node "scripts/setup-local.mjs" "$@"
