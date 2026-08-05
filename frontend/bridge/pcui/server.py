"""FastAPI app for `pcui serve` (frontend/design.md §4): DTO-mapped query endpoints over the
worker pool, the session/artifact store with optimistic locking + SSE, and the bootstrap
security gate. Every skill call is a whitelisted command with controlled argument
construction — no argv/path passthrough from the client, ever."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.staticfiles import StaticFiles

from . import mappers
from .capabilities import assemble
from .openapi import install_openapi
from .paths import META_DATA
from .security import COOKIE_NAME, Security
from .store import Conflict, NotFound, Store
from .team_matchup import MatchupInputError, run_actual_matchup
from .team_tune import TuneInputError, run_team_tune
from .worker import WorkerError, WorkerPool

MAX_BODY = 2 * 1024 * 1024
QUERY_TIMEOUT = 60.0
TEAM_TIMEOUT = 600.0
_DEPLOYMENT_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}\Z")

DEX_KINDS = ("pokemon", "move", "item", "ability", "nature")
DEX_MAPPERS = {"pokemon": mappers.map_pokemon, "move": mappers.map_move,
               "item": mappers.map_item, "ability": mappers.map_ability,
               "nature": mappers.map_nature}
# team ops the bridge accepts inside a session spec (deterministic operators only, P0).
TEAM_OPS = {"parse", "validate", "diagnose", "matchup", "select", "repset", "observed",
            "landscape", "search", "show", "oppmatrix", "intake", "context-audit", "frame",
            "slate-evaluate", "checkpoint", "draft-init", "fill", "answer-audit", "tune",
            "replace", "vocab"}
# Session-op fields team.py treats as LOCAL FILE PATHS. The bridge never forwards client
# strings here (arbitrary-file read, §4.3); clients send inline JSON and the bridge
# materializes it into controlled temp files.
TEAM_FILE_FIELDS = ("file", "context", "slate", "frame_output", "slate_output",
                    "audit_receipt")


def _raw_or_error(doc: Any) -> Any:
    """Pass a CLI error shape through as a 404/400 instead of mapping it."""
    if isinstance(doc, dict) and doc.get("error"):
        code = doc["error"].get("code", "bad_input")
        raise HTTPException(404 if code == "not_found" else 400, detail=doc)
    return doc


# The per-slot placeholder a batch endpoint puts where a non-object input was, so the input→result
# position contract holds. Matches the uniform ErrorShape (ok:false + error) the batch DTOs validate
# against (read-only; safe to share one instance across slots).
_BAD_INPUT_ITEM = {"ok": False, "error": {"code": "bad_input", "message": "item must be an object"}}


class _SpaStaticFiles(StaticFiles):
    """Static SPA hosting: unknown paths fall back to index.html so client-side routes
    survive a refresh (the /api and /projection mounts resolve first). Starlette signals
    a missing file either as a 404 response or an HTTPException depending on version —
    handle both."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        from starlette.exceptions import HTTPException as StarletteHTTPException
        served_index = False
        try:
            response = await super().get_response(path, scope)
            if response.status_code == 404:
                response = await super().get_response("index.html", scope)
                served_index = True
        except StarletteHTTPException as e:
            if e.status_code != 404:
                raise
            response = await super().get_response("index.html", scope)
            served_index = True
        # The SPA entry must revalidate on every load: it names the current hashed JS/CSS bundles, so
        # a heuristically cached index.html leaves a new deploy invisible until a hard refresh (same
        # class of bug as the client-side manifest no-store fix). The bundles themselves are content-
        # hashed and stay immutable-cacheable.
        # "." is what Starlette's normpath yields for a bare "/" request; "" / "index.html" cover the
        # other direct hits, and served_index covers client-route fallbacks.
        if served_index or path in ("", ".", "index.html"):
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(store: Store, pool: WorkerPool, security: Security,
               deployment_id: str | None = None,
               dist_dir: Path | None = None,
               projection_dir: Path | None = None,
               bind_host: str = "127.0.0.1") -> FastAPI:
    if deployment_id is not None and not _DEPLOYMENT_ID_RE.fullmatch(deployment_id):
        raise ValueError(f"invalid deployment id: {deployment_id!r}")
    app = FastAPI(title="pcui bridge", docs_url=None, redoc_url=None, openapi_url=None)
    # The projection's matchup grids are large, highly repetitive JSON (the variant-expanded doubles
    # KO grid is ~13 MB raw) and compress to 6-8% of that. Serving them uncompressed would send
    # ~13 MB where ~0.8 MB suffices, so compression is not an optimisation here — it is what makes
    # shipping the full grid viable at all.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    state: dict[str, Any] = {"capabilities": None}
    caps_lock = asyncio.Lock()               # assemble the ~40MB digest at most once, even
    #                                          under concurrent first requests
    trend_cache: dict[str, tuple[float, Any]] = {}   # format -> (mtime, mapped TrendDto)
    # format -> (mtime, compact raw store, mapped per-Pokemon DTOs)
    usage_trend_cache: dict[str, tuple[float, dict, dict[str, Any]]] = {}
    oppcache_cache: dict[str, tuple[float, Any]] = {}   # "format:view" -> (mtime, mapped DTO)
    subscribers: set[asyncio.Queue] = set()
    loop_ref: dict[str, asyncio.AbstractEventLoop] = {}
    # When the operator deliberately binds beyond localhost (cli.py prints a warning and
    # requires typed consent), the localhost host/origin allowlist would otherwise reject
    # every real request — so relax it for the consented bind and rely on the CLI-secret /
    # cookie auth. A localhost bind keeps the strict anti-DNS-rebinding gate.
    allow_any_host = not security.host_allowed(bind_host)

    async def query(cli_id: str, argv: list[str], stdin: str | None = None,
                    timeout: float = QUERY_TIMEOUT) -> Any:
        """Run a worker query and parse it, mapping failures to structured error responses
        instead of a bare 500: a worker timeout -> 504, unparseable CLI output -> 502."""
        try:
            return await asyncio.to_thread(pool.request_json, cli_id, argv, stdin, timeout)
        except WorkerError as e:
            raise HTTPException(504, {"error": {"code": "bad_input", "message": str(e)}})
        except (json.JSONDecodeError, ValueError):
            raise HTTPException(502, {"error": {"code": "bad_input",
                                     "message": f"{cli_id} produced no parseable output"}})

    def on_event(event: dict) -> None:
        loop = loop_ref.get("loop")
        if loop is None:
            return
        for q in list(subscribers):
            loop.call_soon_threadsafe(q.put_nowait, event)

    store.subscribe(on_event)

    @app.middleware("http")
    async def gate(request: Request, call_next):
        if not allow_any_host:
            if not security.host_allowed(request.headers.get("host")):
                return Response(status_code=403, content="forbidden host")
            if not security.origin_allowed(request.headers.get("origin")):
                return Response(status_code=403, content="forbidden origin")
        # Body-size gate. Parse Content-Length defensively (a bogus value must be a 400, not a
        # 500), and require it on body-bearing methods: a chunked request carries no
        # Content-Length and would otherwise bypass MAX_BODY entirely with unbounded buffering.
        cl = request.headers.get("content-length")
        try:
            length = int(cl) if cl is not None else None
        except ValueError:
            return Response(status_code=400, content="invalid content-length")
        if length is not None and length > MAX_BODY:
            # Drain a BOUNDED oversize before answering so the client's send() completes and can READ
            # this 413, instead of the Windows connection RST it sees when the socket closes with the
            # request body still unread. The pcui client also pre-checks size (cli.MAX_REQUEST_BODY);
            # this backstops other callers. Absurd bodies (> 4x the cap) are left to reset (rare).
            if length <= 4 * MAX_BODY:
                await request.body()
            return Response(status_code=413, media_type="application/json",
                            content=json.dumps({"error": {"code": "body_too_large", "limit": MAX_BODY}}),
                            headers={"Connection": "close"})
        if length is None and request.method in ("POST", "PUT", "PATCH"):
            return Response(status_code=411, content="length required")
        # Authentication guards the API only; static assets (dist, projection, runtime
        # config) are public data the SPA needs BEFORE it can bootstrap a cookie.
        if request.url.path.startswith("/api/") and request.url.path != "/api/bootstrap":
            if not security.is_authenticated(request.cookies.get(COOKIE_NAME),
                                             request.headers.get("x-pcui-secret")):
                return Response(status_code=401, content="unauthenticated")
        return await call_next(request)

    @app.get("/runtime-config.json")
    async def runtime_config():
        return {"runtime": "local", "apiBase": "/api", "projectionBase": "/projection"}

    @app.get("/api/health")
    async def health():
        # O(1) liveness probe for the CLI's daemon check — avoids pulling the whole session
        # list (an N+1 that grew with history) just to confirm the daemon answers.
        return {"ok": True}

    # -- bootstrap / capabilities -----------------------------------------------------

    @app.post("/api/bootstrap")
    async def bootstrap(body: dict, response: Response):
        cookie = security.consume_bootstrap(str(body.get("token", "")))
        if cookie is None:
            raise HTTPException(401, "invalid or already-used bootstrap token")
        response.set_cookie(COOKIE_NAME, cookie, httponly=True, samesite="strict")
        return {"ok": True}

    @app.get("/api/capabilities")
    async def capabilities():
        async with caps_lock:                  # assembled once; the lock stops two concurrent
            if state["capabilities"] is None:  # first requests from each running the full pass
                state["capabilities"] = await asyncio.to_thread(
                    assemble, pool, deployment_id)
        return state["capabilities"]

    # -- dex ---------------------------------------------------------------------------

    @app.post("/api/dex/{kind}")
    async def dex_query(kind: str, body: dict):
        if kind not in DEX_KINDS:
            raise HTTPException(404, "unknown dex kind")
        name = str(body.get("name", ""))[:200]
        if not name:
            raise HTTPException(400, "name required")
        if name.startswith("-"):
            # A leading '-' would be parsed as a CLI flag (argparse SystemExit, empty stdout)
            # rather than a query term; no dex name starts with one. Reject up front.
            raise HTTPException(400, "name must not start with '-'")
        doc = await query("dex", [kind, name, "--format", "json"])
        return DEX_MAPPERS[kind](_raw_or_error(doc))

    @app.post("/api/dex/resolve/batch")
    async def dex_resolve(body: dict):
        names = [str(n)[:200] for n in (body.get("names") or [])][:100]
        if not names:
            raise HTTPException(400, "names required")
        if any(n.startswith("-") for n in names):
            raise HTTPException(400, "names must not start with '-'")
        argv = ["resolve", *names, "--format", "json"]
        kind = body.get("kind")
        if kind in DEX_KINDS:
            argv += ["--kind", kind]
        doc = await query("dex", argv)
        return [mappers.map_resolve_entry(e) for e in doc]

    # -- meta --------------------------------------------------------------------------

    @app.get("/api/meta/ranking")
    async def meta_ranking(format: str = "single", limit: int = 50):
        if format not in ("single", "double"):
            raise HTTPException(400, "format must be single|double")
        limit = max(1, min(int(limit), 300))
        doc = await query("meta",
                          ["ranking", "--format", format, "--limit", str(limit),
                           "--output", "json"])
        return mappers.map_ranking(_raw_or_error(doc))

    @app.get("/api/meta/detail")
    async def meta_detail(format: str, pokemon: str):
        if format not in ("single", "double"):
            raise HTTPException(400, "format must be single|double")
        doc = await query("meta",
                          ["detail", "--format", format, "--pokemon", str(pokemon)[:200],
                           "--output", "json"])
        try:
            return await asyncio.to_thread(mappers.map_detail, _raw_or_error(doc))
        except mappers.MappingError as e:
            # A panel name the dex snapshot can't resolve (meta refreshed ahead of the dex).
            # Surface a structured error instead of a bare 500 the UI can't distinguish.
            raise HTTPException(502, {"error": {"code": "not_found", "message": str(e)}})

    @app.get("/api/meta/trend")
    async def meta_trend(format: str = "single"):
        if format not in ("single", "double"):
            raise HTTPException(400, "format must be single|double")

        def _load() -> Any:
            # Read + map off the event loop, and reuse the mapped DTO until the file's mtime
            # changes (a whole-season trend file is re-read + re-mapped on every request
            # otherwise, blocking the loop each time).
            current = json.loads((META_DATA / "current.json").read_text(encoding="utf-8"))
            season = current["current"]["season"]
            path = META_DATA / f"trend_{season}_{format}.json"
            if not path.exists():
                return None
            mtime = path.stat().st_mtime
            cached = trend_cache.get(format)
            if cached is None or cached[0] != mtime:
                cached = (mtime, mappers.map_trend(
                    json.loads(path.read_text(encoding="utf-8"))))
                trend_cache[format] = cached
            return cached[1]

        dto = await asyncio.to_thread(_load)
        if dto is None:
            raise HTTPException(404, f"no trend store for {format}")
        return dto

    @app.get("/api/meta/usage-trend")
    async def meta_usage_trend(format: str, pokemon: str):
        if format not in ("single", "double"):
            raise HTTPException(400, "format must be single|double")
        slug = str(pokemon)[:200]

        def _load() -> Any:
            current = json.loads((META_DATA / "current.json").read_text(encoding="utf-8"))
            season = current["current"]["season"]
            path = META_DATA / f"usage_trend_{season}_{format}.json"
            if not path.exists():
                return None
            mtime = path.stat().st_mtime
            cached = usage_trend_cache.get(format)
            if cached is None or cached[0] != mtime:
                cached = (
                    mtime,
                    json.loads(path.read_text(encoding="utf-8")),
                    {},
                )
                usage_trend_cache[format] = cached
            if slug not in cached[1].get("pokemon", {}):
                return None
            if slug not in cached[2]:
                cached[2][slug] = mappers.map_usage_trend(cached[1], slug)
            return cached[2][slug]

        try:
            dto = await asyncio.to_thread(_load)
        except mappers.MappingError as exc:
            raise HTTPException(502, {"error": {"code": "not_found",
                                                "message": str(exc)}}) from exc
        if dto is None:
            raise HTTPException(404, f"no usage trend for {pokemon} in {format}")
        return dto

    # -- calc --------------------------------------------------------------------------

    @app.post("/api/calc/damage")
    async def calc_damage(body: dict):
        payload = json.dumps({k: body[k] for k in ("attacker", "defender", "move", "field")
                              if k in body}, ensure_ascii=False)
        doc = await query("calc", ["one"], payload)
        return mappers.map_damage(_raw_or_error(doc))

    @app.post("/api/calc/speedline")
    async def calc_speedline(body: dict):
        doc = await query("speedline", ["one"], json.dumps(body, ensure_ascii=False))
        return mappers.map_speedline(_raw_or_error(doc))

    @app.post("/api/calc/batch")
    async def calc_batch(body: dict):
        # One attacker's several moves × several defenders, dispatched as ONE fault-isolated batch
        # (the calc CLI's `batch` command reuses a single loaded engine) instead of N×M requests.
        items = body.get("items")
        if not isinstance(items, list) or not items:
            raise HTTPException(400, "items required")
        if len(items) > 240:
            raise HTTPException(413, "too many items")
        # Keep the input→result position contract: a non-object item can't be sent to the engine, so
        # it gets a bad_input error IN ITS OWN SLOT instead of being dropped (which would shift every
        # later result onto the wrong request cell — external audit 2026-07-14).
        valid = [(i, {k: it[k] for k in ("attacker", "defender", "move", "field") if k in it})
                 for i, it in enumerate(items) if isinstance(it, dict)]
        doc = await query("calc", ["batch"], json.dumps([v[1] for v in valid], ensure_ascii=False))
        if not isinstance(doc, list) or len(doc) != len(valid):
            raise HTTPException(502, {"error": {"code": "bad_input",
                                     "message": "calc batch produced a mismatched array"}})
        # Each engine result is a success (mapped) or the uniform error shape (one bad cell never
        # fails the grid); bad_input fills the slots that never reached the engine.
        out: list[Any] = [_BAD_INPUT_ITEM for _ in items]
        for (orig_i, _), res in zip(valid, doc):
            out[orig_i] = res if (isinstance(res, dict) and res.get("error")) \
                else mappers.map_damage(res)
        return out

    @app.post("/api/calc/speedbatch")
    async def calc_speedbatch(body: dict):
        # A whole speed ladder (my mon + opponents) resolved in ONE fault-isolated speedline batch
        # (the speed tool's tier list + the tune tool never fire per-mon round-trips).
        items = body.get("items")
        if not isinstance(items, list) or not items:
            raise HTTPException(400, "items required")
        if len(items) > 240:
            raise HTTPException(413, "too many items")
        keys = ("name", "nature", "sps", "ivs", "boosts", "ability", "item", "status", "field")
        # Same position contract as /calc/batch: bad items get bad_input in place, never dropped.
        valid = [(i, {k: it[k] for k in keys if k in it})
                 for i, it in enumerate(items) if isinstance(it, dict)]
        doc = await query("speedline", ["batch"], json.dumps([v[1] for v in valid], ensure_ascii=False))
        if not isinstance(doc, list) or len(doc) != len(valid):
            raise HTTPException(502, {"error": {"code": "bad_input",
                                     "message": "speedline batch produced a mismatched array"}})
        out: list[Any] = [_BAD_INPUT_ITEM for _ in items]
        for (orig_i, _), res in zip(valid, doc):
            out[orig_i] = res if (isinstance(res, dict) and res.get("error")) \
                else mappers.map_speedline(res)
        return out

    # -- team: opponent matchup cache (KO matrix + derived check grid) -------------------

    @app.get("/api/team/oppcache")
    async def team_oppcache(format: str = "single", view: str = "matrix"):
        if format not in ("single", "double"):
            raise HTTPException(400, "format must be single|double")
        if view not in ("matrix", "ko", "checks"):
            raise HTTPException(400, "view must be matrix|ko|checks")

        def _load() -> Any:
            # Read + map off the event loop; reuse the mapped DTO until the cache file's mtime
            # changes (mapping the whole grid — and deriving checks — is not cheap to repeat).
            current = json.loads((META_DATA / "current.json").read_text(encoding="utf-8"))
            rule = current["current"]["rule"]        # the opponent cache is keyed by RULE
            path = META_DATA.parent.parent / "pokemon-champions-team" / "data" \
                / "opponent_cache" / f"{rule}_{format}.json"
            if not path.exists():
                return None
            key = f"{format}:{view}"
            mtime = path.stat().st_mtime
            cached = oppcache_cache.get(key)
            if cached is None or cached[0] != mtime:
                cache = mappers.load_oppcache(format, rule)
                if view == "checks":
                    dto = mappers.map_oppcheck_grid(cache, mappers.derive_oppcheck_grid(cache))
                elif view == "ko":
                    dto = mappers.map_oppko_grid(cache)
                else:
                    dto = mappers.map_oppcache(cache)
                cached = (mtime, dto)
                oppcache_cache[key] = cached
            return cached[1]

        try:
            dto = await asyncio.to_thread(_load)
        except (RuntimeError, ValueError) as exc:
            # StaleCacheError is a RuntimeError; an older cache without check_matrix fails
            # derivation with ValueError. Both are deploy/update-state problems with the same
            # operator action, not opaque application crashes.
            if "opponent cache" not in str(exc):
                raise
            raise HTTPException(503, str(exc)) from exc
        if dto is None:
            raise HTTPException(404, f"no opponent cache for {format}")
        return dto

    # -- team (batched session, raw passthrough in P0) ----------------------------------

    @app.post("/api/team/session")
    async def team_session(body: dict):
        ops = body.get("ops")
        if not isinstance(ops, list) or not ops:
            raise HTTPException(400, "ops required")
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            spec_ops: list[dict] = []
            for i, op in enumerate(ops):
                if not isinstance(op, dict) or op.get("op") not in TEAM_OPS:
                    raise HTTPException(400, f"op not allowed: "
                                        f"{op.get('op') if isinstance(op, dict) else op}")
                out = dict(op)
                for field in TEAM_FILE_FIELDS:
                    value = out.get(field)
                    if value is None:
                        continue
                    if not isinstance(value, (dict, list)):
                        # a client string here would be a local path handed to team.py —
                        # arbitrary-file read. Inline JSON only.
                        raise HTTPException(
                            400, f"ops[{i}].{field} must be inline JSON, not a path")
                    path = tmp_dir / f"op{i}-{field}.json"
                    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
                    out[field] = str(path)
                spec_ops.append(out)
            spec = tmp_dir / "session.json"
            # cmd_session expects the spec's TOP LEVEL to be the command array itself.
            spec.write_text(json.dumps(spec_ops, ensure_ascii=False), encoding="utf-8")
            doc = await asyncio.to_thread(
                pool.request_json, "team", ["session", str(spec)], None, TEAM_TIMEOUT)
        return doc

    @app.post("/api/team/matchup")
    async def actual_team_matchup(body: dict):
        """Actual registered sets versus a caller-selected top-K (1..60).

        This narrower endpoint exists alongside the developer-oriented session surface so both
        runtimes expose one validated UI contract, including free-form text parsing.
        """
        try:
            return await asyncio.to_thread(run_actual_matchup, pool, body)
        except MatchupInputError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, "actual matchup calculation failed") from exc

    @app.post("/api/team/tune")
    async def team_tune(body: dict):
        """Authoritative SP cliff calculation over a path-free team + benchmark request."""
        try:
            return await asyncio.to_thread(run_team_tune, pool, body)
        except TuneInputError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, "team tune calculation failed") from exc

    # -- sessions / artifacts ------------------------------------------------------------

    @app.post("/api/sessions")
    async def create_session(body: dict | None = None):
        return store.create_session((body or {}).get("meta"))

    @app.get("/api/sessions")
    async def list_sessions():
        return store.list_sessions()

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str):
        try:
            out = store.get_session(session_id)
        except NotFound:
            raise HTTPException(404, "session not found")
        out["ledger"] = store.session_ledger(session_id)
        return out

    @app.post("/api/sessions/{session_id}/artifacts")
    async def append_artifact(session_id: str, body: dict):
        kind = str(body.get("kind", ""))
        payload = body.get("payload")
        revision = body.get("revision")
        if not kind or not isinstance(payload, str) or not isinstance(revision, int):
            raise HTTPException(400, "kind, payload (string), revision (int) required")
        try:
            return store.append_artifact(session_id, kind, payload.encode("utf-8"), revision)
        except NotFound:
            raise HTTPException(404, "session not found")
        except Conflict as c:
            changes = store.changes_since_revision(session_id, c.expected)
            raise HTTPException(409, {"expected": c.expected, "actual": c.actual,
                                      "changedKinds": list(dict.fromkeys(
                                          row["kind"] for row in changes)),
                                      "changes": changes,
                                      "session": store.get_session(session_id)})

    @app.get("/api/artifacts/{artifact_hash}")
    async def get_artifact(artifact_hash: str):
        try:
            a = store.get_artifact(artifact_hash)
        except NotFound:
            raise HTTPException(404, "artifact not found")
        return Response(content=a["payload"], media_type="application/json",
                        headers={"X-Artifact-Kind": a["kind"]})

    # -- SSE -----------------------------------------------------------------------------

    @app.get("/api/events")
    async def events():
        loop_ref["loop"] = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        subscribers.add(q)

        async def stream():
            try:
                yield "event: hello\ndata: {}\n\n"
                while True:
                    event = await q.get()
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            finally:
                subscribers.discard(q)

        return StreamingResponse(stream(), media_type="text/event-stream")

    install_openapi(app, "local")

    # Static hosting (mounted last — API routes above resolve first): the projection data
    # layer and the built SPA. A packaged release's shared index names its immutable JS/CSS
    # through the production-scoped URL, so the local release verifier must expose that asset
    # path too even though local projection reads deliberately remain at /projection.
    # Optional so a headless/API-only bridge still runs.
    if deployment_id and dist_dir is not None and (dist_dir / "assets").is_dir():
        app.mount(
            f"/releases/{deployment_id}/dist/assets",
            StaticFiles(directory=str(dist_dir / "assets")),
            name="release-assets",
        )
    if projection_dir is not None and projection_dir.is_dir():
        app.mount("/projection", StaticFiles(directory=str(projection_dir)), name="projection")
    else:
        # No projection mounted: without this, /projection/*.json would fall through to the
        # SPA '/' mount and get index.html with a 200, so the client's fetchJson sees
        # ok=true and dies on JSON.parse('<!doctype html>') — an opaque error that hides the
        # real cause (projection was never built). A real 404 makes the failure legible.
        @app.get("/projection/{_path:path}")
        async def projection_missing(_path: str):
            raise HTTPException(404, "projection not built")

    if dist_dir is not None and dist_dir.is_dir():
        app.mount("/", _SpaStaticFiles(directory=str(dist_dir), html=True), name="spa")

    return app
