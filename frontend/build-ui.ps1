$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    npm ci --ignore-scripts
    python web/scripts/build_projection.py --capability llm.qa --capability llm.builder --capability team.validate --capability team.tune
    npm run build --workspace @pokemon-champions/web
} finally {
    Pop-Location
}
