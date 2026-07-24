"""pcui command line: serve / doctor / session / artifact / run / install-agent.

Connects to a RUNNING daemon over HTTP (X-PCUI-Secret from daemon.json). Direct-SQLite
degradation is allowed ONLY when the daemon is provably not running (daemon.json absent,
stale, or its pid dead) — a running-but-unreachable daemon is an ERROR, never a silent
direct write (apps/design.md §4.2 🚩 split-brain rule)."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import cli_i18n as i18n
from .config import (CONFIG_ENV_NAME, EnvFileError, env_file_values,
                     load_runtime_config)
from .paths import CLIS, META_DATA, SKILLS_ROOT, data_dir
from .security import pid_alive, read_daemon_file
from .store import Store


class DaemonUnreachable(SystemExit):
    pass


def _load_env_file(path: Path) -> None:
    """Load a systemd-EnvironmentFile-style ``KEY=value`` file without executing it.

    The local online rehearsal uses the same repository-external secret shape as production.
    An already-set process variable wins, so systemd or a one-off shell override remains the
    authority. Duplicate keys inside the file follow the usual last-assignment-wins rule.
    """
    try:
        values = env_file_values(path)
    except EnvFileError as exc:
        raise SystemExit(i18n.t("env_file_invalid", path=exc.path, line=exc.line)) from exc
    for key, value in values.items():
        os.environ.setdefault(key, value)


def _daemon() -> dict | None:
    """Running daemon's {port, secret}, None if provably not running, SystemExit if
    running-but-unreachable."""
    info = read_daemon_file()
    if info is None:
        return None
    if not pid_alive(int(info.get("pid", -1))):
        return None
    try:
        _http(info, "GET", "/api/health")      # O(1) probe, not the full session list
        return info
    except urllib.error.URLError:
        raise DaemonUnreachable(
            i18n.t("daemon_unreachable", pid=info["pid"], port=info["port"]))


# Mirror the daemon's server.MAX_BODY. An oversized POST is rejected by the daemon's body-size gate
# BEFORE the request body is drained, so on Windows the socket closes with unread inbound bytes and
# the client's in-progress send() surfaces a bare ConnectionResetError (WinError 10054) instead of
# the server's 413 — the response is never readable. Pre-check the size here so the caller gets an
# actionable message (post a compact/summary artifact) instead of an opaque connection-reset traceback.
MAX_REQUEST_BODY = 2 * 1024 * 1024


def _http(info: dict, method: str, path: str, body: dict | None = None, timeout: float = 30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data is not None and len(data) > MAX_REQUEST_BODY:
        raise SystemExit(
            f"pcui: {path} request body is {len(data):,} bytes, over the daemon's "
            f"{MAX_REQUEST_BODY // (1024 * 1024)} MiB body limit. The daemon would reject it and reset "
            f"the connection — post a compact/summary payload instead (e.g. a trimmed slate artifact).")
    req = urllib.request.Request(
        f"http://127.0.0.1:{info['port']}{path}", method=method,
        data=data,
        headers={"X-PCUI-Secret": info["secret"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _store() -> Store:
    return Store(data_dir() / "sessions.db")


def _projection_deployment_id(value: str | None) -> str | None:
    """Bind a packaged local bridge to the immutable projection it serves."""
    if not value:
        return None
    manifest = Path(value) / "manifest.json"
    try:
        deployment_id = json.loads(manifest.read_text(encoding="utf-8")).get("deploymentId")
    except (OSError, ValueError) as exc:
        raise SystemExit(f"invalid projection manifest: {manifest}: {exc}") from exc
    if not isinstance(deployment_id, str) or not deployment_id:
        raise SystemExit(f"projection manifest has no deploymentId: {manifest}")
    return deployment_id


def _local_unmetered(enabled: bool, host: str, public_origin: str | None) -> bool:
    """Resolve the local-only quota bypass without consulting any request data."""
    if enabled and (host not in {"127.0.0.1", "::1", "localhost"} or public_origin):
        raise ValueError(i18n.t("unlimited_refused"))
    return enabled


def cmd_serve(ns) -> int:
    import uvicorn

    from .security import Security, claim_daemon_file, remove_daemon_file_if_owned
    from .server import create_app
    from .worker import WorkerPool

    if ns.host != "127.0.0.1":
        print(i18n.t("expose_local", host=ns.host))
        if input(i18n.t("confirm")).strip() != "yes":
            return 1
    existing = read_daemon_file()
    if existing and pid_alive(int(existing.get("pid", -1))):
        raise SystemExit(i18n.t("daemon_running", pid=existing["pid"], port=existing["port"]))
    security = Security()
    pool = WorkerPool()
    store = _store()
    app = create_app(store, pool, security,
                     deployment_id=_projection_deployment_id(ns.projection),
                     dist_dir=Path(ns.dist) if ns.dist else None,
                     projection_dir=Path(ns.projection) if ns.projection else None,
                     bind_host=ns.host)
    # Atomic exclusive claim: closes the TOCTOU between the check above and marker creation —
    # a concurrent `serve` that lost the race here cannot clobber the winner's marker.
    if not claim_daemon_file(ns.port, security.cli_secret):
        pool.shutdown()
        live = read_daemon_file() or {}
        raise SystemExit(i18n.t("daemon_running", pid=live.get("pid", "?"), port=live.get("port", "?")))
    # flush: under a pipe (wrapper scripts, log capture) stdout is block-buffered and the
    # banner — the ONLY place the bootstrap token appears — would otherwise arrive late.
    print(f"pcui bridge: http://127.0.0.1:{ns.port}/#bootstrap={security.bootstrap_token}",
          flush=True)
    try:
        uvicorn.run(app, host=ns.host, port=ns.port, log_level="warning")
    finally:
        pool.shutdown()
        remove_daemon_file_if_owned()      # never erase a marker this process did not write
    return 0


def cmd_online_serve(ns) -> int:
    """The PUBLIC online API (apps/design.md §7) — an independent process, not the local
    bridge: no daemon.json claim, no bootstrap token; anonymity + limits are the security
    model. Binds localhost by default (production puts Nginx in front, §8)."""
    import uvicorn

    from .online.jobs import JobStore
    from .online.limits import OnlineLimits, QaLimitConfig
    from .online.provider import (EchoProvider, FallbackProvider, OpenAIChatConfig,
                                  OpenAICompatibleProvider)
    from .online.server import create_online_app
    from .worker import WorkerPool

    _load_env_file(Path(ns.env_file))

    public_origin = os.environ.get("PCUI_PUBLIC_ORIGIN") or None
    try:
        unmetered = _local_unmetered(
            bool(ns.local_online_unlimited), ns.host, public_origin)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    if ns.host != "127.0.0.1":
        print(i18n.t("expose_online", host=ns.host))
        if input(i18n.t("confirm")).strip() != "yes":
            return 1
    if ns.provider == "echo":
        provider = EchoProvider()
        thinking_provider = provider
    elif ns.provider in {"openai-compatible", "opencode", "deepseek"}:
        try:
            llm_config = OpenAIChatConfig.from_env(os.environ, provider=ns.provider)
            fallback_config = (OpenAIChatConfig.from_env(os.environ, provider="deepseek")
                               if ns.provider == "opencode" else None)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        base_provider = OpenAICompatibleProvider(llm_config) if llm_config.api_key else None
        provider = base_provider.with_thinking(False) if base_provider else None
        thinking_provider = base_provider.with_thinking(True) if base_provider else None
        if fallback_config and fallback_config.api_key:
            fallback_base = OpenAICompatibleProvider(fallback_config)
            fallback = fallback_base.with_thinking(False)
            thinking_fallback = fallback_base.with_thinking(True)
            provider = FallbackProvider(provider, fallback) if provider else fallback
            thinking_provider = (FallbackProvider(thinking_provider, thinking_fallback)
                                 if thinking_provider else thinking_fallback)
        if provider is None:
            print(i18n.t("llm_key_missing"))
    else:
        provider = None
        thinking_provider = None
    secret = os.environ.get("PCUI_ONLINE_SECRET", "")
    if not secret:
        import secrets as _secrets
        secret = _secrets.token_hex(16)
        print(i18n.t("secret_missing"))
    limits = OnlineLimits(data_dir() / "online.db", secret,
                          QaLimitConfig(daily_limit=ns.qa_daily_limit,
                                        daily_token_budget=ns.qa_token_budget))
    dev_key = os.environ.get("PCUI_DEV_KEY") or None
    pool = WorkerPool()
    app = create_online_app(
        pool, provider, limits, thinking_provider=thinking_provider,
        dist_dir=Path(ns.dist) if ns.dist else None,
        projection_dir=Path(ns.projection) if ns.projection else None,
        public_origin=public_origin,
        idle_reap_seconds=ns.worker_idle if ns.worker_idle > 0 else None,
        dev_key=dev_key,
        unmetered=unmetered,
        # web_jobs (§7.3): transient builder-job rows share online.db — same retention
        # discipline as the limits tables, swept on traffic.
        jobs=JobStore(data_dir() / "online.db"))
    provider_summary = getattr(provider, "safe_summary", None)
    provider_text = ((f"{provider_summary()}, "
                      "qa=non-thinking, diagnose/builder=optional high-effort thinking")
                     if provider_summary
                     else ns.provider if provider else "none")
    print(f"pcui online API: http://127.0.0.1:{ns.port}/ "
          f"(provider: {provider_text}"
          f"{', local unmetered' if unmetered else ''}"
          f"{', dev bypass enabled' if dev_key else ''})", flush=True)
    try:
        uvicorn.run(app, host=ns.host, port=ns.port, log_level="warning")
    finally:
        pool.shutdown()
    return 0


def cmd_doctor(ns) -> int:
    checks: list[tuple[str, bool, str]] = []
    for cli_id, path in CLIS.items():
        checks.append((i18n.t("check_skill", name=cli_id), path.exists(), str(path)))
    mirror = SKILLS_ROOT.parent.parent / ".claude" / "skills"
    checks.append((i18n.t("check_mirror"), mirror.is_dir(), str(mirror)))
    try:
        import quickjs  # type: ignore  # noqa: F401
        checks.append((i18n.t("check_quickjs"), True, i18n.t("calc_runtime")))
    except ImportError:
        node = shutil.which("node")
        checks.append((i18n.t("check_node"), node is not None, node or i18n.t("calc_missing")))
    current = META_DATA / "current.json"
    checks.append((i18n.t("check_meta"), current.exists(), str(current)))
    db = data_dir() / "sessions.db"
    checks.append((i18n.t("check_write"), data_dir().is_dir(), str(db)))
    info = read_daemon_file()
    running = bool(info and pid_alive(int(info.get("pid", -1))))
    checks.append((i18n.t("check_daemon"), True,
                   i18n.t("running", port=info["port"]) if running else i18n.t("not_running")))

    ok = True
    for name, passed, detail in checks:
        ok &= passed
        status = i18n.t("status_ok" if passed else "status_fail")
        print(f"  [{status}] {name}: {detail}")
    if ok:
        # end-to-end: one real dex query through a one-shot subprocess
        from .runner import run_cli
        probe = json.loads(run_cli("dex", ["resolve", "Garchomp", "--format", "json"])["stdout"])
        good = bool(probe and probe[0].get("ok"))
        status = i18n.t("status_ok" if good else "status_fail")
        print(f"  [{status}] {i18n.t('check_probe')}")
        ok &= good
    print(i18n.t("doctor_ok" if ok else "doctor_fail"))
    return 0 if ok else 1


def cmd_session(ns) -> int:
    daemon = _daemon()
    if ns.action == "create":
        out = (_http(daemon, "POST", "/api/sessions", {"meta": {}}) if daemon
               else _store().create_session())
    elif ns.action == "list":
        out = (_http(daemon, "GET", "/api/sessions") if daemon
               else _store().list_sessions())
    else:                                     # show
        if not ns.id:
            raise SystemExit(i18n.t("need_id"))
        if daemon:
            out = _http(daemon, "GET", f"/api/sessions/{ns.id}")
        else:
            s = _store()
            out = s.get_session(ns.id)
            out["ledger"] = s.session_ledger(ns.id)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_artifact(ns) -> int:
    daemon = _daemon()
    if ns.action == "put":
        payload = Path(ns.file).read_text(encoding="utf-8") if ns.file else sys.stdin.read()
        if daemon:
            session = _http(daemon, "GET", f"/api/sessions/{ns.session}")
            out = _http(daemon, "POST", f"/api/sessions/{ns.session}/artifacts",
                        {"kind": ns.kind, "payload": payload,
                         "revision": session["revision"]})
        else:
            s = _store()
            revision = s.get_session(ns.session)["revision"]
            out = s.append_artifact(ns.session, ns.kind, payload.encode("utf-8"), revision)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    # get: latest artifact of the kind via session heads. Resolve heads once (either channel),
    # check the kind once, then fetch the payload over the matching channel.
    store = None if daemon else _store()
    heads = (_http(daemon, "GET", f"/api/sessions/{ns.session}")["heads"] if daemon
             else store.get_session(ns.session)["heads"])
    h = heads.get(ns.kind)
    if not h:
        raise SystemExit(i18n.t("no_artifact", kind=ns.kind))
    if daemon:
        req = urllib.request.Request(
            f"http://127.0.0.1:{daemon['port']}/api/artifacts/{h}",
            headers={"X-PCUI-Secret": daemon["secret"]})
        with urllib.request.urlopen(req, timeout=30) as resp:
            sys.stdout.write(resp.read().decode("utf-8"))
    else:
        sys.stdout.write(store.get_artifact(h)["payload"].decode("utf-8"))
    return 0


# Convenience flags for op fields team.py reads as FILES. The CLI inlines the file CONTENT
# (the daemon refuses client-supplied paths, §4.3); the authoritative op/field whitelist
# lives in server.py — anything else rides --args and is validated there.
_RUN_FILE_FIELDS = ("file", "context", "slate", "frame_output", "slate_output", "audit_receipt")


def cmd_run(ns) -> int:
    daemon = _daemon()
    if daemon is None:
        raise SystemExit(i18n.t("run_need_daemon"))
    op: dict = {"op": ns.op}
    if ns.args:
        extra = json.loads(ns.args)
        if not isinstance(extra, dict):
            raise SystemExit(i18n.t("args_object"))
        op.update(extra)
    for field in _RUN_FILE_FIELDS:
        path = getattr(ns, field)
        if path:
            op[field] = json.loads(Path(path).read_text(encoding="utf-8"))
    out = _http(daemon, "POST", "/api/team/session", {"ops": [op]}, timeout=630)
    result = out[0] if isinstance(out, list) and len(out) == 1 else out
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if (isinstance(result, dict) and result.get("rc", 0) == 0) else 1


COMPANION_NAME = "pokemon-champions-ui-session"
_AGENT_SKILL_DIRS = {"claude": Path.home() / ".claude" / "skills",
                     "codex": Path.home() / ".codex" / "skills"}


def _companion_dest(ns) -> Path:
    base = Path(ns.dir) if ns.dir else _AGENT_SKILL_DIRS[ns.target]
    return base / COMPANION_NAME


def cmd_install_agent(ns) -> int:
    dest = _companion_dest(ns)
    template = (Path(__file__).parent / "companion" / "SKILL.md").read_text(encoding="utf-8")
    bridge_dir = Path(__file__).resolve().parents[1]
    pcui_cmd = "pcui" if shutil.which("pcui") else "python -m pcui"
    text = (template.replace("{{PCUI_CMD}}", pcui_cmd)
                    .replace("{{BRIDGE_DIR}}", str(bridge_dir)))
    print(i18n.t("companion_dest", dest=dest / "SKILL.md"))
    if not ns.yes and input(i18n.t("write_confirm")).strip() != "yes":
        return 1
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "SKILL.md").write_text(text, encoding="utf-8")
    print(i18n.t("installed"))
    return 0


def cmd_uninstall_agent(ns) -> int:
    dest = _companion_dest(ns)
    marker = dest / "SKILL.md"
    # Refuse to delete anything that is not OUR skill: the target dir must carry the
    # companion's own name in its frontmatter. Protects against a mistyped --dir.
    if not marker.is_file() or f"name: {COMPANION_NAME}" not in marker.read_text(encoding="utf-8"):
        raise SystemExit(i18n.t("refuse_delete", dest=dest, name=COMPANION_NAME))
    shutil.rmtree(dest)
    print(i18n.t("removed", dest=dest))
    return 0


def main(argv: list[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    # Select the display language before constructing argparse so --help itself is
    # localized. Keep command names and machine-readable JSON language-invariant.
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--lang", choices=i18n.LANGS)
    pre.add_argument("--env-file")
    selected, _ = pre.parse_known_args(raw_argv)
    i18n.set_lang(selected.lang)
    argparse._ = i18n.argparse_text  # type: ignore[attr-defined]

    ap = argparse.ArgumentParser(prog="pcui", description=i18n.t("description"))
    ap.add_argument("--lang", choices=i18n.LANGS, help=i18n.t("lang_help"))
    try:
        config_path = Path(selected.env_file).expanduser() if selected.env_file else (
            data_dir() / CONFIG_ENV_NAME)
        runtime_config = load_runtime_config(config_path)
    except ValueError as exc:
        ap.error(str(exc))
    sub = ap.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help=i18n.t("serve_help"))
    serve.add_argument("--port", type=int, default=runtime_config.local_port)
    serve.add_argument("--host", default="127.0.0.1")
    _web = SKILLS_ROOT.parent.parent / "apps" / "web"
    serve.add_argument("--dist", default=str(_web / "dist") if (_web / "dist").is_dir() else None,
                       help=i18n.t("dist_help"))
    serve.add_argument("--projection",
                       default=str(_web / "public/projection")
                       if (_web / "public/projection").is_dir() else None,
                       help=i18n.t("projection_help"))
    serve.set_defaults(fn=cmd_serve)

    online = sub.add_parser("online-serve", help=i18n.t("online_help"))
    online.add_argument("--port", type=int, default=runtime_config.online_port)
    online.add_argument("--host", default="127.0.0.1")
    online.add_argument("--provider",
                        choices=["openai-compatible", "opencode", "deepseek", "echo", "none"],
                        default=runtime_config.llm_provider
                        if runtime_config.online_use_api_key else "none",
                        help=i18n.t("provider_help"))
    online.add_argument("--env-file", default=str(config_path),
                        help=i18n.t("env_file_help"))
    online.add_argument("--qa-daily-limit", type=int, default=15,
                        help=i18n.t("qa_limit_help"))
    online.add_argument("--qa-token-budget", type=int, default=1_500_000,
                        help=i18n.t("qa_budget_help"))
    online.add_argument("--worker-idle", type=float, default=600.0,
                        help=i18n.t("idle_help"))
    online.add_argument("--dist", default=str(_web / "dist") if (_web / "dist").is_dir() else None,
                        help=i18n.t("dist_help"))
    online.add_argument("--projection",
                        default=str(_web / "public/projection")
                        if (_web / "public/projection").is_dir() else None,
                        help=i18n.t("projection_help"))
    online.set_defaults(local_online_unlimited=runtime_config.local_online_unlimited)
    online.set_defaults(fn=cmd_online_serve)

    doctor = sub.add_parser("doctor", help=i18n.t("doctor_help"))
    doctor.set_defaults(fn=cmd_doctor)

    session = sub.add_parser("session", help=i18n.t("session_help"))
    session.add_argument("action", choices=["create", "list", "show"])
    session.add_argument("--id")
    session.set_defaults(fn=cmd_session)

    artifact = sub.add_parser("artifact", help=i18n.t("artifact_help"))
    artifact.add_argument("action", choices=["get", "put"])
    artifact.add_argument("--session", required=True)
    artifact.add_argument("--kind", required=True)
    artifact.add_argument("--file")
    artifact.set_defaults(fn=cmd_artifact)

    run = sub.add_parser("run", help=i18n.t("run_help"))
    run.add_argument("op", help=i18n.t("op_help"))
    run.add_argument("--args", help=i18n.t("args_help"))
    for f in _RUN_FILE_FIELDS:
        run.add_argument(f"--{f.replace('_', '-')}", dest=f,
                         help=i18n.t("file_help", field=f))
    run.set_defaults(fn=cmd_run)

    for name, fn in (("install-agent", cmd_install_agent),
                     ("uninstall-agent", cmd_uninstall_agent)):
        p = sub.add_parser(
            name,
            help=i18n.t("install_help" if name == "install-agent" else "uninstall_help"),
        )
        p.add_argument("--target", choices=sorted(_AGENT_SKILL_DIRS), default="claude")
        p.add_argument("--dir", help=i18n.t("dir_help"))
        if name == "install-agent":
            p.add_argument("--yes", action="store_true", help=i18n.t("yes_help"))
        p.set_defaults(fn=fn)

    ns = ap.parse_args(raw_argv)
    return ns.fn(ns)


if __name__ == "__main__":
    raise SystemExit(main())
