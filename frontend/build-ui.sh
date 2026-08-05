#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
npm ci --ignore-scripts
python3 web/scripts/build_projection.py --capability llm.qa --capability llm.builder --capability team.validate --capability team.tune
npm run build --workspace @pokemon-champions/web
