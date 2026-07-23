$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = Join-Path $root 'apps/bridge'
$env:PCUI_SKILLS_ROOT = Join-Path $root '.agents/skills'
python -m pcui serve --dist (Join-Path $root 'apps/web/dist') --projection (Join-Path $root 'apps/web/public/projection')
