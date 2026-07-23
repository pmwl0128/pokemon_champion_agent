"""One-shot subprocess execution of a skill CLI — the correctness baseline every resident
worker falls back to (apps/design.md §4.1: worker errors degrade here, results equivalent)."""
from __future__ import annotations

import subprocess
import sys

from .paths import CLIS, PROJECT_ROOT


class SkillError(RuntimeError):
    """The CLI failed hard (no parseable stdout)."""


def run_cli(cli_id: str, argv: list[str], stdin: str | None = None,
            timeout: float = 60.0) -> dict:
    """Run one CLI invocation; returns {ok, stdout, exit}. `stdout` is the raw text the
    CLI printed — callers json.loads it (error shapes included; conventions §3 keeps
    graceful misses as parseable JSON with exit 0)."""
    cli = CLIS[cli_id]
    proc = subprocess.run(
        [sys.executable, str(cli), *argv],
        input=stdin, capture_output=True, text=True, encoding="utf-8",
        timeout=timeout, cwd=PROJECT_ROOT,
    )
    if not proc.stdout.strip() and proc.returncode != 0:
        raise SkillError(f"{cli_id} {argv[:2]} failed (exit {proc.returncode}): "
                         f"{proc.stderr.strip()[:500]}")
    return {"ok": proc.returncode == 0, "stdout": proc.stdout, "exit": proc.returncode}
