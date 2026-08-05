$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = Join-Path $root 'bridge'
$env:PCUI_SKILLS_ROOT = Join-Path (Split-Path -Parent $root) '.agents/skills'
python -m pcui serve --dist (Join-Path $root 'web/dist') --projection (Join-Path $root 'web/public/projection')
