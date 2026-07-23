#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$ROOT/apps/bridge"
export PCUI_SKILLS_ROOT="$ROOT/.agents/skills"
exec python3 -m pcui serve --dist "$ROOT/apps/web/dist" --projection "$ROOT/apps/web/public/projection"
