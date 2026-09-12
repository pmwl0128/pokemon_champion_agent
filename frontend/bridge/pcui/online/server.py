"""FastAPI app for `pcui online-serve` (frontend/design.md §2 online column, §7): the public
API face of the online site. It serves ONLY what the static projection cannot — /api/qa
(llm.qa), the builder wizard (llm.builder, §7.3), and deterministic team diagnose
(team.validate, §7.5) — plus optional static hosting for dev
parity. Trust model is the opposite of the local bridge: no bootstrap cookie, no
authenticated surface; anonymity + per-identity limits + the daily budget breaker ARE the
protection (§7.4). Every skill call remains a whitelisted command with controlled argument
construction (§7.5)."""
from __future__ import annotations

import asyncio
import functools
import hmac
import json
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from starlette.middleware.gzip import GZipMiddleware
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.staticfiles import StaticFiles

from . import builder, qa
from .jobs import JobStore
from .limits import BudgetExhausted, OnlineLimits, RateLimited
from .provider import LlmProvider, LlmUnavailable
from ..openapi import install_openapi
from ..team_matchup import MatchupInputError, run_actual_matchup
from ..team_tune import TuneInputError, run_team_tune

QA_COOKIE = "pcqa_device"
MAX_BODY = 32 * 1024            # /api/qa and /api/builder bodies are small
QA_QUEUE_WAIT = 15.0            # seconds a request may wait for a QA slot before 429
BUILDER_QUEUE_CAP = 3           # queued builds beyond the running one before 429 busy
BUILDER_TACTICS = ("stall", "trickroom", "weather", "tailwind", "screens",
                   "pivot", "setup", "hazards")
DIAGNOSE_TEXT_MAX = 8_000       # a 6-member Showdown export is ~2KB; team-json ~4KB
DIAGNOSE_TIMEOUT = 150.0        # one team.py session (parse, then validate+diagnose)
DIAGNOSE_STREAM_HEARTBEAT = 15.0  # keep the proxy/client path alive while deterministic work runs
DIAGNOSE_TOP_K = 30             # independent live battery scope; team skill permits 1..60
MATCHUP_QUEUE_WAIT = 20.0        # deterministic lane: bounded wait, never consumes model quota
MATCHUP_WORK_UNIT_PAIRS = 30     # ceil(member_count * top_k / 30); max 12x60 costs 24 units
TUNE_QUEUE_WAIT = 20.0           # shares the heavy deterministic lane with actual matchup
_DEPLOYMENT_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}\Z")


def _err(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def create_online_app(pool, provider: LlmProvider | None, limits: OnlineLimits, *,
                      thinking_provider: LlmProvider | None = None,
                      dist_dir: Path | None = None,
                      projection_dir: Path | None = None,
                      deployment_id: str | None = None,
                      public_origin: str | None = None,
                      qa_concurrency: int = 2,
                      deterministic_workers: int = 4,
                      idle_reap_seconds: float | None = None,
                      dev_key: str | None = None,
                      unmetered: bool = False,
                      jobs: JobStore | None = None) -> FastAPI:
    app = FastAPI(title="pcui online", docs_url=None, redoc_url=None, openapi_url=None)
    # Thread lanes. §7.5 says model work and CPU work must not exhaust each other, and the
    # semaphores below implement that — but every blocking call still went through
    # `asyncio.to_thread`, i.e. asyncio's implicit default executor, whose size is
    # `min(32, cpu_count + 4)`: SIX threads on a 2-vCPU host. The lane budget summed to exactly
    # that, so the separation was real at the semaphore layer and false one layer down: a burst
    # of QA requests parked on LLM round trips could starve diagnose/matchup even with a free
    # deterministic slot and an idle CPU. These pools make the split structural.
    #
    # Sizing rationale differs per lane and is deliberately NOT cpu_count-derived:
    #   llm  - pure network wait, costs a thread and no CPU, so it only needs to exceed the
    #          QA/explanation semaphores.
    #   det  - each in-flight request is an unshared team.py process tree (~210 MB RSS, about
    #          one saturated core), so its ceiling is the host, not a thread count. Measured
    #          on the 2-vCPU host, throughput peaks at concurrency 2 and DECLINES past it
    #          while latency grows — overshooting this lane is not a safe trade (design §9.1).
    #   build- one builder pipeline holds its thread for the whole 420 s deadline while
    #          interleaving LLM waits with team.py batches; it gets its own lane so that long
    #          hold can never occupy a deterministic slot.
    llm_pool = ThreadPoolExecutor(max_workers=max(4, qa_concurrency * 2),
                                  thread_name_prefix="pcui-llm")
    det_pool = ThreadPoolExecutor(max_workers=max(2, deterministic_workers),
                                  thread_name_prefix="pcui-det")
    builder_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pcui-build")

    def _in(pool: ThreadPoolExecutor, fn, *args):
        """Run a blocking call on an explicit lane. `run_in_executor` takes no kwargs, and the
        callers below pass positionally, so partial() is enough and keeps the sites readable."""
        return asyncio.get_running_loop().run_in_executor(pool, functools.partial(fn, *args))
    # See the local bridge: the variant-expanded matchup grids are ~13 MB raw and ~0.8 MB gzipped.
    # This is what makes serving the full grid to a public visitor viable.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    # QA gets its own small semaphore (§7.5: LLM and deterministic work never share one) —
    # there is no deterministic compute here at all, calc runs in the visitor's browser.
    qa_slots = asyncio.Semaphore(qa_concurrency)
    # Builder: site-wide concurrency of ONE (§7.4) — the position in line is visible via the
    # job snapshot. Separate from the QA semaphore by design (§7.5).
    builder_slots = asyncio.Semaphore(1)
    # SSE fan-out for job updates: JobStore.on_change fires from the worker thread; the
    # bridge hops onto the loop and every subscriber of that job re-reads the tiny snapshot.
    job_subs: dict[str, set[asyncio.Queue]] = {}
    loop_ref: dict[str, asyncio.AbstractEventLoop] = {}
    builder_tasks: set[asyncio.Task] = set()
    diagnose_stream_tasks: set[asyncio.Task] = set()

    def _job_changed(job_id: str) -> None:
        loop = loop_ref.get("loop")
        if loop is None:
            return

        def _push() -> None:
            for q in job_subs.get(job_id, ()):  # snapshot re-read happens in the handler
                q.put_nowait(job_id)
        loop.call_soon_threadsafe(_push)

    if jobs is not None:
        jobs.set_on_change(_job_changed)

    def _set_cookie(response: Response, value: str) -> None:
        response.set_cookie(QA_COOKIE, value, httponly=True, samesite="lax",
                            max_age=180 * 24 * 3600)

    @app.middleware("http")
    async def gate(request: Request, call_next):
        cl = request.headers.get("content-length")
        try:
            length = int(cl) if cl is not None else None
        except ValueError:
            return Response(status_code=400, content="invalid content-length")
        if length is not None and length > MAX_BODY:
            # Drain a bounded oversize before answering so the client can READ this 413 instead of a
            # connection reset (socket closed with the body unread). Absurd bodies are left to reset.
            if length <= 4 * MAX_BODY:
                await request.body()
            return Response(status_code=413, media_type="application/json",
                            content=json.dumps({"error": {"code": "body_too_large", "limit": MAX_BODY}}),
                            headers={"Connection": "close"})
        if length is None and request.method in ("POST", "PUT", "PATCH"):
            return Response(status_code=411, content="length required")
        # Same-origin deployment (§8): when the public origin is configured, refuse
        # cross-site POSTs (quota burning via CSRF). Header-less clients (curl) pass —
        # this is an anti-abuse gate, not authentication.
        if public_origin and request.method in ("POST", "PUT", "PATCH"):
            origin = request.headers.get("origin")
            if origin is not None and origin.rstrip("/") != public_origin.rstrip("/"):
                return Response(status_code=403, content="forbidden origin")
        # Mint the anonymous device identity HERE (scoped to the LLM entry points, so static/
        # cache responses never carry a Set-Cookie) and set it on EVERY such response —
        # success OR error. If it were only set on the 200 path, a visitor whose first
        # questions hit 429/503 would never receive a cookie and keep minting fresh device
        # ids (only the IP key would bind).
        new_cookie = None
        if request.url.path in ("/api/qa", "/api/builder", "/api/team/diagnose",
                                "/api/team/matchup", "/api/team/tune", "/api/quota"):
            device_id, new_cookie = limits.device_cookie(request.cookies.get(QA_COOKIE))
            request.state.device_id = device_id
        response = await call_next(request)
        if new_cookie:
            _set_cookie(response, new_cookie)
        return response

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    @app.get("/api/capabilities")
    async def capabilities():
        """Projection identity plus the capabilities of THIS running API process.

        The static projection deliberately advertises only features that work without a backend.
        A provider-backed deployment adds QA/diagnose/builder at runtime; without this merge the SPA
        hid every main navigation item after Calc even though the endpoints were live. Endpoint
        authorization and quotas remain authoritative — this document only controls visibility.
        """
        if projection_dir is None:
            raise HTTPException(404, _err("not_found", "no projection capabilities"))
        try:
            doc = json.loads(
                (projection_dir / "capabilities.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(503, _err("projection_unavailable",
                                          "projection capabilities unavailable")) from None
        # A release projection records what its deployment can expose, but this handshake describes
        # THIS process. A missing provider/job store must remove stale optional LLM capabilities from
        # the static document instead of leaving visible UI routes whose endpoints only return 503.
        advertised = [cap for cap in (doc.get("capabilities") or [])
                      if cap not in ("llm.qa", "llm.builder")]
        if "team.validate" not in advertised:
            advertised.append("team.validate")
        if "team.tune" not in advertised:
            advertised.append("team.tune")
        if provider is not None:
            for capability in ("llm.qa",):
                if capability not in advertised:
                    advertised.append(capability)
            if jobs is not None and "llm.builder" not in advertised:
                advertised.append("llm.builder")
        return {**doc, "capabilities": advertised}

    def _quota_for(device_id: str, client_ip: str, device_prefix: str,
                   ip_prefix: str, limit: int) -> dict:
        device_used, _ = limits.usage(f"{device_prefix}:{device_id}", limit)
        ip_used, _ = limits.usage(f"{ip_prefix}:{limits.ip_hash(client_ip)}", limit)
        return {"used": max(device_used, ip_used), "limit": limit}

    @app.get("/api/quota")
    async def quota_status(request: Request):
        if unmetered:
            empty = {"used": 0, "limit": 0}
            return {"qa": empty, "diagnose": empty, "builder": empty, "matchup": empty,
                    "tune": empty}
        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        return {
            "qa": _quota_for(device_id, client_ip, "d", "i", limits.cfg.daily_limit),
            "diagnose": _quota_for(device_id, client_ip, "td", "ti",
                                   limits.cfg.diagnose_daily_limit),
            "builder": _quota_for(device_id, client_ip, "bd", "bi",
                                   limits.cfg.builder_daily_limit),
            "matchup": _quota_for(device_id, client_ip, "md", "mi",
                                   limits.cfg.matchup_daily_limit),
            "tune": _quota_for(device_id, client_ip, "ud", "ui",
                                limits.cfg.tune_daily_limit),
        }

    @app.post("/api/qa")
    async def qa_endpoint(request: Request, body: dict):
        question = str(body.get("question", "")).strip()
        lang = body.get("lang")
        if lang not in ("zh", "en", "ja"):
            lang = "zh"
        if not question:
            raise HTTPException(400, _err("bad_input", "question required"))
        if len(question) > qa.QA_QUESTION_MAX_CHARS:
            raise HTTPException(400, _err("bad_input",
                                          f"question over {qa.QA_QUESTION_MAX_CHARS} chars"))
        if provider is None:
            raise HTTPException(503, _err("llm_unavailable", "no LLM provider configured"))

        # device id was minted + set as a cookie by the gate middleware (on every /api/qa
        # response, success or error); fall back defensively if it is somehow absent.
        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        ids = [f"d:{device_id}", f"i:{limits.ip_hash(client_ip)}"]
        # Dev bypass (maintainer testing / §9 benchmark): a matching X-PCUI-Dev-Key skips
        # the daily count AND the budget breaker's rejection — but real token spend is
        # still recorded (record_spent), so the day's cost total never lies.
        dev = bool(dev_key) and hmac.compare_digest(
            request.headers.get("x-pcui-dev-key", ""), dev_key or "")
        bypass_limits = dev or unmetered
        quota_day: str | None = None
        budget_day: str | None = None
        if unmetered:
            used, limit = 0, 0
        elif dev:
            used, limit = limits.usage(ids[0])
        else:
            try:
                used, limit, quota_day = limits.check_and_consume(ids)
            except RateLimited:
                raise HTTPException(429, _err("rate_limited", "daily question limit reached"))
            try:
                budget_day = limits.reserve_budget()
            except BudgetExhausted:
                limits.refund(ids, quota_day)
                raise HTTPException(503, _err("budget_exhausted",
                                              "daily model budget exhausted — try tomorrow"))

        def fail_cleanup(tokens: int = 0) -> None:
            """Non-dev: release the reservation (on its booked day) and give the visitor their
            count back (the failure is ours). Dev: just record what was really burned. Binding
            the day keeps a midnight-straddling request settling the row it reserved."""
            if bypass_limits:
                limits.record_spent(tokens)
            else:
                limits.settle_budget(tokens, budget_day)
                limits.refund(ids, quota_day)

        started = time.monotonic()
        # Acquire a QA slot with a bounded queue wait. We deliberately do NOT wrap acquire() in
        # asyncio.wait_for: a wait_for timeout that races a just-freed permit can leave the
        # permit taken while the caller believes it timed out — a permanent leak that eventually
        # deadlocks the endpoint. asyncio.wait never cancels the task, so on timeout we hand the
        # permit back if/when it lands.
        acq = asyncio.ensure_future(qa_slots.acquire())
        done, _pending = await asyncio.wait({acq}, timeout=QA_QUEUE_WAIT)
        if acq not in done:
            acq.add_done_callback(
                lambda t: qa_slots.release()
                if not t.cancelled() and t.exception() is None else None)
            fail_cleanup()
            raise HTTPException(429, _err("busy", "too many concurrent questions — retry"))
        try:
            result = await _in(llm_pool, qa.answer, pool, provider, question, lang)
        except LlmUnavailable as e:
            fail_cleanup(getattr(e, "tokens", 0))   # earlier rounds' spend settles truthfully
            raise HTTPException(503, _err("llm_unavailable", str(e)))
        except qa.QaFailed as e:
            fail_cleanup(e.tokens)      # tokens were really burned — settle truthfully
            raise HTTPException(502, _err("llm_failed", str(e)))
        except Exception:
            traceback.print_exc()       # see the builder path: the client gets a code, the
            fail_cleanup()              # operator gets the cause. The reservation must never leak.
            raise HTTPException(500, _err("bad_input", "qa pipeline failed"))
        finally:
            qa_slots.release()
        if bypass_limits:
            limits.record_spent(result["tokens"])
        else:
            limits.settle_budget(result["tokens"], budget_day)
        payload = {"answer": result["answer"], "toolTrace": result["toolTrace"],
                   "grounded": bool(result.get("grounded", result["toolTrace"])),
                   "quota": {"used": used, "limit": limit}}
        if dev:
            # Metric split for the maintainer/benchmark only — never sent to real visitors.
            payload["debug"] = {
                "promptTokens": result.get("promptTokens", 0),
                "completionTokens": result.get("completionTokens", 0),
                "cacheHitTokens": result.get("cacheHitTokens", 0),
                "llmCalls": result.get("llmCalls", 0),
                "toolBytes": result.get("toolBytes", 0),
                "ms": round((time.monotonic() - started) * 1000),
            }
        return payload

    # -- team diagnose (deterministic report + optional reading, design §7.5) ---------------
    # Deterministic CPU work gets its own semaphore; an optional reading uses the LLM lane.
    #
    # These two, `deterministic_workers` and `WorkerPool.ONESHOT_LIMIT` all spend ONE budget
    # (design §9.1). On the 2-vCPU host the measured optimum for total deterministic concurrency
    # is 2 — diagnose 1 + matchup/tune 1 is exactly that, so these are calibrated rather than
    # merely cautious. Raise them together with the core count, never in isolation, and
    # re-derive with frontend/bridge/tools/capacity_benchmark.py on the target host.
    diagnose_slots = asyncio.Semaphore(1)
    matchup_slots = asyncio.Semaphore(1)

    def _run_diagnose(text: str, fmt: str) -> dict:
        """Best-effort parsing tiers (§7.5): structured (Showdown / team-json) -> compact
        community share layout (normalizer) -> bare species extraction over the raw text.
        Parsed members and extracted species MERGE — extraction fills members the parser
        missed as species-only entries — so a bare list of six names still yields a partial
        report (diagnose itself degrades honestly: neutral speed assumptions, partial
        roles/checks). Raises ValueError('unparseable') only when NOTHING resolves."""
        import tempfile

        from .. import mappers
        from .teamtext import extract_species, normalize_team_text, resolve_species
        norm = normalize_team_text(text)
        with tempfile.TemporaryDirectory(prefix="pcweb-diag-") as tmp:
            tmp_dir = Path(tmp)
            team_file = tmp_dir / "team.txt"
            team_file.write_text(norm, encoding="utf-8")
            spec = tmp_dir / "spec.json"
            spec.write_text(json.dumps([{"op": "parse", "file": str(team_file)}]),
                            encoding="utf-8")
            out = pool.request_json("team", ["session", str(spec)], None, DIAGNOSE_TIMEOUT)
            entry = out[0] if isinstance(out, list) and out else {}
            parsed = entry.get("result") if isinstance(entry, dict) else None
            members = [m for m in ((parsed or {}).get("pokemon") or [])
                       if isinstance(m, dict) and m.get("species")] \
                if entry.get("rc") == 0 else []
            if members:
                # parse structures but does NOT translate names (normalizing into the
                # schema is the caller's job, same contract as the local agent flow): snap
                # species/items/moves to dex canonical first, then DROP members whose
                # species still doesn't resolve — those are mis-split text lines, and a
                # wrong member misleads more than a missing one.
                builder.canonicalize_members(pool, members, time.monotonic() + 60)
                ok = set(resolve_species(pool, [m["species"] for m in members]))
                members = [m for m in members if m["species"] in ok]
            if len(members) < 6:
                # Tier 3: recognize species anywhere in the RAW text and fill the gaps as
                # species-only members. The report's TeamCard discloses what was recognized.
                have = {m.get("species") for m in members}
                for name in extract_species(pool, text):
                    if len(members) >= 6:
                        break
                    if name not in have:
                        members.append({"species": name, "item": None, "ability": None,
                                        "moves": [], "nature": None, "spread": None,
                                        "tera": None,
                                        "completeness": "observed_species_only"})
                        have.add(name)
            if not members:
                raise ValueError("unparseable")
            team = {"schema_version": 1, "format": fmt, "season": None, "rule": None,
                    "pokemon": members[:6], "provenance": None}
            spec2 = tmp_dir / "spec2.json"
            team_json = tmp_dir / "team.json"
            team_json.write_text(json.dumps(team, ensure_ascii=False), encoding="utf-8")
            spec2.write_text(json.dumps([
                {"op": "validate", "file": str(team_json)},
                # with_check: the per-opponent C2/C1/C0 grid vs the top-K meta — extra CPU
                # on the shipped opponent cache, but the report's most actionable fact.
                {"op": "diagnose", "file": str(team_json), "aspect": "all",
                 "top_k": DIAGNOSE_TOP_K,
                 "with_check": True},
            ]), encoding="utf-8")
            out2 = pool.request_json("team", ["session", str(spec2)], None, DIAGNOSE_TIMEOUT)
        if not isinstance(out2, list) or len(out2) != 2 \
                or not isinstance(out2[0].get("result"), dict) \
                or not isinstance(out2[1].get("result"), dict):
            raise RuntimeError("diagnose session failed")
        return mappers.map_diagnose_report(team, out2[0]["result"], out2[1]["result"])

    async def _execute_team_diagnose(request: Request, body: dict, on_report=None):
        fmt = body.get("format")
        text = str(body.get("text") or "")
        lang = body.get("lang") if body.get("lang") in ("zh", "en", "ja") else "zh"
        want_explain = bool(body.get("explain"))
        thinking = bool(body.get("thinking"))
        if fmt not in ("single", "double") or not text.strip() \
                or len(text) > DIAGNOSE_TEXT_MAX:
            raise HTTPException(400, _err("bad_input", "format and team text required"))
        if thinking and not want_explain:
            raise HTTPException(400, _err("bad_input", "thinking requires AI explanation"))
        selected_provider = thinking_provider if thinking else provider
        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        ids = [f"td:{device_id}", f"ti:{limits.ip_hash(client_ip)}"]
        cost = 2 if thinking else 1
        # Same dev bypass as Q&A and the builder: release smoke and maintainer testing must not
        # spend a visitor-facing daily allowance, while real token spend is still recorded.
        dev = bool(dev_key) and hmac.compare_digest(
            request.headers.get("x-pcui-dev-key", ""), dev_key or "")
        bypass_limits = dev or unmetered
        quota_day: str | None = None
        if unmetered:
            used, limit = 0, 0
        elif dev:
            used, limit = limits.usage(ids[0], limits.cfg.diagnose_daily_limit)
        else:
            try:
                used, limit, quota_day = limits.check_and_consume(
                    ids, limits.cfg.diagnose_daily_limit, cost=cost)
            except RateLimited:
                raise HTTPException(429, _err("rate_limited", "daily diagnose limit reached"))
        try:
            async with diagnose_slots:
                report = await _in(det_pool, _run_diagnose, text, fmt)
        except ValueError:
            if not bypass_limits:
                limits.refund(ids, quota_day, cost=cost)
            raise HTTPException(400, _err("unparseable", "could not parse a team from the text"))
        except Exception:
            if not bypass_limits:
                limits.refund(ids, quota_day, cost=cost)
            raise HTTPException(500, _err("bad_input", "diagnose pipeline failed"))
        report["quota"] = {"used": used, "limit": limit}
        if on_report is not None and want_explain:
            # The deterministic report is already complete and useful. Stream this immutable
            # snapshot before the optional model call so a thinking-mode visitor can inspect
            # legality, structure and matchups instead of staring at a spinner for another minute.
            # With no explanation there is no second phase: emitting report + done would send the
            # same ~500 KB payload twice and increases the chance of a proxy/client interruption.
            await on_report(report)

        # Optional reading uses the diagnosis allowance, never the separate Q&A allowance.
        if want_explain and selected_provider is not None:
            if bypass_limits:
                try:
                    async with qa_slots:
                        explanation, tokens = await _in(
                            llm_pool, qa.explain_diagnose, selected_provider, report, lang)
                    limits.record_spent(tokens)
                    report["explanation"] = explanation
                except Exception as e:
                    limits.record_spent(getattr(e, "tokens", 0))
                    report["explanationError"] = "llm_failed"
                return report
            try:
                try:
                    budget_day = limits.reserve_budget()
                except BudgetExhausted:
                    raise
                async with qa_slots:
                    try:
                        explanation, tokens = await _in(
                            llm_pool, qa.explain_diagnose, selected_provider, report, lang)
                    except Exception as e:
                        limits.settle_budget(getattr(e, "tokens", 0), budget_day)
                        raise
                limits.settle_budget(tokens, budget_day)
                report["explanation"] = explanation
            except BudgetExhausted:
                report["explanationError"] = "budget_exhausted"
            except Exception:
                report["explanationError"] = "llm_failed"
        elif want_explain:
            report["explanationError"] = "llm_unavailable"
        if report.get("explanationError") and thinking and not bypass_limits:
            # The ordinary deterministic diagnosis was delivered; return only the extra
            # thinking unit when the enhanced reading itself failed.
            limits.refund(ids, quota_day, cost=1)
            report["quota"] = _quota_for(device_id, client_ip, "td", "ti", limit)
        return report

    @app.post("/api/team/diagnose")
    async def team_diagnose(request: Request, body: dict):
        if "application/x-ndjson" not in request.headers.get("accept", ""):
            return await _execute_team_diagnose(request, body)

        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

        async def emit_report(report: dict) -> None:
            event = {"type": "report", "report": report}
            await queue.put(("report", json.dumps(event, ensure_ascii=False)))

        async def run_stream() -> None:
            try:
                final = await _execute_team_diagnose(request, body, emit_report)
            except HTTPException as exc:
                event = {"type": "error", "status": exc.status_code, "detail": exc.detail}
                await queue.put(("error", json.dumps(event, ensure_ascii=False)))
            except Exception:
                event = {"type": "error", "status": 500,
                         "detail": _err("bad_input", "diagnose pipeline failed")}
                await queue.put(("error", json.dumps(event, ensure_ascii=False)))
            else:
                event = {"type": "done", "report": final}
                await queue.put(("done", json.dumps(event, ensure_ascii=False)))

        task = asyncio.create_task(run_stream())
        diagnose_stream_tasks.add(task)
        task.add_done_callback(diagnose_stream_tasks.discard)

        async def events():
            while True:
                try:
                    kind, line = await asyncio.wait_for(
                        queue.get(), timeout=DIAGNOSE_STREAM_HEARTBEAT)
                except asyncio.TimeoutError:
                    # Valid NDJSON event which old/new clients safely ignore. An empty line may be
                    # swallowed by buffering proxies; a small object guarantees observable bytes.
                    yield '{"type":"progress"}\n'
                    continue
                yield line + "\n"
                if kind in ("done", "error"):
                    break

        return StreamingResponse(events(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-store",
                                          "X-Accel-Buffering": "no"})

    @app.post("/api/team/matchup")
    async def actual_team_matchup(request: Request, body: dict):
        """Actual registered sets vs top-K usage targets (deterministic; no LLM quota)."""
        acquire = asyncio.ensure_future(matchup_slots.acquire())
        done, _pending = await asyncio.wait({acquire}, timeout=MATCHUP_QUEUE_WAIT)
        if acquire not in done:
            acquire.add_done_callback(
                lambda task: matchup_slots.release()
                if not task.cancelled() and task.exception() is None else None)
            raise HTTPException(429, _err("busy", "matchup calculator is busy — retry"))
        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        ids = [f"md:{device_id}", f"mi:{limits.ip_hash(client_ip)}"]
        dev = bool(dev_key) and hmac.compare_digest(
            request.headers.get("x-pcui-dev-key", ""), dev_key or "")
        bypass_limits = dev or unmetered
        quota_day: str | None = None
        quota_cost = 0

        def consume_workload(member_count: int, top_k: int) -> None:
            nonlocal quota_day, quota_cost
            quota_cost = max(1, (member_count * top_k + MATCHUP_WORK_UNIT_PAIRS - 1)
                             // MATCHUP_WORK_UNIT_PAIRS)
            _used, _limit, quota_day = limits.check_and_consume(
                ids, limits.cfg.matchup_daily_limit, cost=quota_cost)

        try:
            try:
                return await _in(
                    det_pool, run_actual_matchup, pool, body,
                    None if bypass_limits else consume_workload)
            except RateLimited:
                raise HTTPException(429, _err("rate_limited",
                                              "daily matchup workload limit reached"))
            except MatchupInputError as exc:
                if not bypass_limits and quota_cost:
                    limits.refund(ids, quota_day, cost=quota_cost)
                raise HTTPException(400, _err("bad_input", str(exc))) from exc
            except Exception as exc:
                if not bypass_limits and quota_cost:
                    limits.refund(ids, quota_day, cost=quota_cost)
                raise HTTPException(500, _err("calculation_failed",
                                              "actual matchup calculation failed")) from exc
        finally:
            matchup_slots.release()

    @app.post("/api/team/tune")
    async def team_tune(request: Request, body: dict):
        """Authoritative SP cliff cards, metered per explicit benchmark and never by LLM quota."""
        acquire = asyncio.ensure_future(matchup_slots.acquire())
        done, _pending = await asyncio.wait({acquire}, timeout=TUNE_QUEUE_WAIT)
        if acquire not in done:
            acquire.add_done_callback(
                lambda task: matchup_slots.release()
                if not task.cancelled() and task.exception() is None else None)
            raise HTTPException(429, _err("busy", "tune calculator is busy — retry"))
        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        ids = [f"ud:{device_id}", f"ui:{limits.ip_hash(client_ip)}"]
        dev = bool(dev_key) and hmac.compare_digest(
            request.headers.get("x-pcui-dev-key", ""), dev_key or "")
        bypass_limits = dev or unmetered
        quota_day: str | None = None
        quota_cost = 0

        def consume_workload(benchmark_count: int) -> None:
            nonlocal quota_day, quota_cost
            quota_cost = benchmark_count
            _used, _limit, quota_day = limits.check_and_consume(
                ids, limits.cfg.tune_daily_limit, cost=quota_cost)

        try:
            try:
                result = await _in(
                    det_pool, run_team_tune, pool, body,
                    None if bypass_limits else consume_workload)
                used, limit = ((0, 0) if unmetered else
                               limits.usage(ids[0], limits.cfg.tune_daily_limit))
                return {**result, "quota": {"used": used, "limit": limit}}
            except RateLimited:
                raise HTTPException(429, _err("rate_limited",
                                              "daily tune workload limit reached"))
            except TuneInputError as exc:
                if not bypass_limits and quota_cost:
                    limits.refund(ids, quota_day, cost=quota_cost)
                raise HTTPException(400, _err("bad_input", str(exc))) from exc
            except Exception as exc:
                if not bypass_limits and quota_cost:
                    limits.refund(ids, quota_day, cost=quota_cost)
                raise HTTPException(500, _err("calculation_failed",
                                              "team tune calculation failed")) from exc
        finally:
            matchup_slots.release()

    # -- builder wizard (llm.builder, design §7.3) -----------------------------------------

    def _clean_list(raw, cap: int) -> list[str] | None:
        """A list of short names, or None on shape/arg-safety violations (leading '-' would
        reach the resolver argv as a flag)."""
        if raw is None:
            return []
        if not isinstance(raw, list) or len(raw) > cap:
            return None
        out = []
        for v in raw:
            name = str(v).strip()[:100]
            if not name or name.startswith("-"):
                return None
            out.append(name)
        return out

    def _resolve_species(names: list[str]) -> dict[str, str]:
        """name -> canonical for the resolved subset (misses simply absent). Runs in a
        worker thread (resident dex worker)."""
        if not names:
            return {}
        doc = pool.request_json("dex", ["resolve", *names[:60], "--format", "json",
                                        "--kind", "pokemon"], timeout=30.0)
        out: dict[str, str] = {}
        for entry in doc if isinstance(doc, list) else []:
            if isinstance(entry, dict) and entry.get("ok") and entry.get("canonical"):
                out[str(entry.get("query"))] = str(entry["canonical"])
        return out

    @app.post("/api/builder")
    async def builder_start(request: Request, body: dict):
        thinking = bool(body.get("thinking"))
        selected_provider = thinking_provider if thinking else provider
        if selected_provider is None or jobs is None:
            raise HTTPException(503, _err("llm_unavailable", "builder backend not configured"))
        fmt = body.get("format")
        posture = body.get("posture")
        if fmt not in ("single", "double") or posture not in ("offense", "balance", "defense"):
            raise HTTPException(400, _err("bad_input", "format/posture required"))
        anchor_raw = str(body.get("anchor") or "").strip()[:100]
        if anchor_raw.startswith("-"):
            raise HTTPException(400, _err("bad_input", "bad anchor"))
        owned = _clean_list(body.get("owned"), 30)
        avoid = _clean_list(body.get("avoid"), 10)
        wants = body.get("wants") or []
        # Bound + dedup server-side: the UI offers 8 fixed tactics, but a hand-rolled client
        # could POST a list with thousands of duplicate tokens to bloat the prompt context
        # and burn extra budget (audit 2026-07-16). Cap at the vocabulary size, then dedup.
        if owned is None or avoid is None or not isinstance(wants, list) \
                or len(wants) > len(BUILDER_TACTICS) \
                or any(t not in BUILDER_TACTICS for t in wants):
            raise HTTPException(400, _err("bad_input", "bad owned/avoid/wants"))
        wants = list(dict.fromkeys(wants))      # order-preserving dedup

        # Resolve every species input up front — an unresolvable name is the VISITOR's to fix
        # (400 with the misses), never something to silently drop from their constraints.
        pending = ([anchor_raw] if anchor_raw else []) + owned + avoid
        resolved = await _in(det_pool, _resolve_species, pending) if pending else {}
        misses = [n for n in pending if n not in resolved]
        if misses:
            raise HTTPException(400, _err("unresolved_names", ", ".join(misses[:10])))
        anchor = resolved.get(anchor_raw) if anchor_raw else None
        form = builder.BuilderForm(
            format=fmt, anchor=anchor,
            anchor_is_mega=bool(anchor and anchor.startswith("Mega ")),
            posture=posture,
            owned=[resolved[n] for n in owned],
            avoid=[resolved[n] for n in avoid],
            wants=[str(t) for t in wants],
            lang=body.get("lang") if body.get("lang") in ("zh", "en", "ja") else "zh",
        )
        if anchor and anchor in form.avoid:
            raise HTTPException(400, _err("bad_input", "anchor is in the avoid list"))
        if anchor and form.owned and anchor not in form.owned:
            form.owned.append(anchor)      # a locked anchor is implicitly available

        device_id = getattr(request.state, "device_id", None) or limits.device_cookie(None)[0]
        client_ip = request.client.host if request.client else "unknown"
        # Distinct identity prefix = a separate daily counter from QA (same table/expiry).
        ids = [f"bd:{device_id}", f"bi:{limits.ip_hash(client_ip)}"]
        cost = 2 if thinking else 1
        dev = bool(dev_key) and hmac.compare_digest(
            request.headers.get("x-pcui-dev-key", ""), dev_key or "")
        bypass_limits = dev or unmetered
        pess = limits.cfg.builder_pessimistic_tokens
        quota_day: str | None = None
        budget_day: str | None = None
        if unmetered:
            used, limit = 0, 0
        elif dev:
            used, limit = limits.usage(ids[0], limits.cfg.builder_daily_limit)
        else:
            try:
                used, limit, quota_day = limits.check_and_consume(
                    ids, limits.cfg.builder_daily_limit, cost=cost)
            except RateLimited:
                raise HTTPException(429, _err("rate_limited", "daily build limit reached"))
            try:
                budget_day = limits.reserve_budget(pess)
            except BudgetExhausted:
                limits.refund(ids, quota_day, cost=cost)
                raise HTTPException(503, _err("budget_exhausted",
                                              "daily model budget exhausted — try tomorrow"))

        def fail_cleanup(tokens: int = 0) -> None:
            if bypass_limits:
                limits.record_spent(tokens)
            else:
                limits.settle_budget(tokens, budget_day, pess)
                limits.refund(ids, quota_day, cost=cost)

        jobs.sweep()
        if jobs.queued_count() >= BUILDER_QUEUE_CAP:
            fail_cleanup()
            raise HTTPException(429, _err("busy", "build queue is full — retry later"))
        job_id = jobs.create()

        async def run() -> None:
            async with builder_slots:
                jobs.set_running(job_id)

                def progress(gate: str, status: str, detail: dict | None = None,
                             raw: dict | None = None) -> None:
                    jobs.set_gate(job_id, gate, status, detail, raw)
                try:
                    result = await _in(
                        builder_pool, builder.build, pool, selected_provider, form, progress)
                except LlmUnavailable as e:
                    fail_cleanup(getattr(e, "tokens", 0))
                    jobs.fail(job_id, "llm_unavailable")
                except builder.BuilderFailed as e:
                    fail_cleanup(e.tokens)     # our failure — count AND reservation returned
                    jobs.fail(job_id, e.code)
                except asyncio.CancelledError:
                    # A graceful shutdown / deploy restart cancels the in-flight task.
                    # CancelledError is a BaseException, so `except Exception` below never
                    # sees it — without this the quota count and the up-to-60k token
                    # reservation would leak until the UTC-midnight rollover (audit
                    # 2026-07-16). Refund, then re-raise to honour the cancellation.
                    fail_cleanup()
                    jobs.fail(job_id, "internal")
                    raise
                except Exception:
                    # "internal" is all the CLIENT may learn (a traceback can echo prompt or
                    # config fragments), but swallowing it entirely left operators with a job
                    # marked failed and no cause anywhere — the reason this class of fault took
                    # a manual repro to diagnose twice. Log it where the operator already looks.
                    traceback.print_exc()
                    fail_cleanup()
                    jobs.fail(job_id, "internal")
                else:
                    if bypass_limits:
                        limits.record_spent(result["tokens"])
                    else:
                        limits.settle_budget(result["tokens"], budget_day, pess)
                    payload = {k: result[k] for k in
                               ("team", "legality", "audit", "checkpointDecisions",
                                "assumptions", "slateTopK", "repaired", "worstMatchup",
                                "rationale", "threats", "matchupThreats", "megaCount")
                         if k in result}
                    if dev:
                        payload["debug"] = {
                            "tokens": result["tokens"],
                            "promptTokens": result.get("promptTokens", 0),
                            "completionTokens": result.get("completionTokens", 0),
                            "cacheHitTokens": result.get("cacheHitTokens", 0),
                            "llmCalls": result.get("llmCalls", 0),
                        }
                    jobs.finish(job_id, payload)

        task = asyncio.get_running_loop().create_task(run())
        builder_tasks.add(task)
        task.add_done_callback(builder_tasks.discard)
        snap = jobs.snapshot(job_id) or {"queuePosition": 0}
        return {"jobId": job_id, "queuePosition": snap["queuePosition"],
                "quota": {"used": used, "limit": limit}}

    @app.get("/api/builder/jobs/{job_id}")
    async def builder_job(job_id: str):
        snap = jobs.snapshot(job_id) if jobs is not None else None
        if snap is None:
            raise HTTPException(404, _err("not_found", "unknown or expired job"))
        return snap

    @app.get("/api/builder/jobs/{job_id}/events")
    async def builder_job_events(job_id: str):
        snap = jobs.snapshot(job_id) if jobs is not None else None
        if snap is None:
            raise HTTPException(404, _err("not_found", "unknown or expired job"))
        q: asyncio.Queue = asyncio.Queue()
        job_subs.setdefault(job_id, set()).add(q)

        async def stream():
            try:
                current = snap
                while True:
                    yield f"data: {json.dumps(current, ensure_ascii=False)}\n\n"
                    if current["status"] in ("done", "failed"):
                        return
                    try:
                        await asyncio.wait_for(q.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"     # keepalive through Nginx's read timeout
                        continue
                    nxt = jobs.snapshot(job_id)
                    if nxt is None:
                        return
                    current = nxt
            finally:
                subs = job_subs.get(job_id)
                if subs is not None:
                    subs.discard(q)
                    if not subs:
                        job_subs.pop(job_id, None)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"X-Accel-Buffering": "no",
                                          "Cache-Control": "no-store"})

    @app.on_event("startup")
    async def _capture_loop() -> None:
        loop = asyncio.get_running_loop()
        loop_ref["loop"] = loop
        # Pin the default executor too. Everything on a request path now names its lane
        # explicitly, so this only carries the maintenance calls (idle reaping, shutdown) —
        # but leaving it implicit would silently reintroduce a cpu_count-derived pool whose
        # size nobody chose.
        loop.set_default_executor(
            ThreadPoolExecutor(max_workers=2, thread_name_prefix="pcui-maint"))

    @app.on_event("shutdown")
    async def _stop_lanes() -> None:
        # Do not wait: a lane may be holding a 420 s builder or a 240 s matchup, and shutdown
        # must not block on it. The owned subprocesses are reaped by `pool.shutdown` below.
        for lane in (llm_pool, det_pool, builder_pool):
            lane.shutdown(wait=False, cancel_futures=True)

    # Optional static hosting: production puts Nginx in front (§8) — these mounts give the
    # SAME layout locally so the online runtime is testable end-to-end before a VPS exists.
    # A packaged release uses only deployment-scoped immutable paths. The fallback aliases are
    # retained for ad-hoc source-tree development, where no release identity is available.
    if deployment_id is not None and not _DEPLOYMENT_ID_RE.fullmatch(deployment_id):
        raise ValueError(f"invalid deployment id: {deployment_id!r}")
    release_prefix = f"/releases/{deployment_id}" if deployment_id else None
    projection_base = f"{release_prefix}/projection" if release_prefix else "/projection"
    # A `local-*` id is the SOURCE-TREE projection (capabilities.assemble derives it whenever no
    # release binds a real one), and it is paired with the deployment-NEUTRAL vite build whose
    # index.html references `./assets/`. Only a packaged release ships an index rebound to the
    # scoped path, so only a packaged release may retire the stable aliases — otherwise a bare
    # `online-serve` 404s every asset of a bare `npm run build`, which is exactly the source-tree
    # case these aliases exist for.
    packaged_release = bool(deployment_id) and not deployment_id.startswith("local-")

    @app.get("/runtime-config.json")
    async def runtime_config():
        doc = {"runtime": "online", "apiBase": "/api", "projectionBase": projection_base}
        if deployment_id:
            doc["deploymentId"] = deployment_id
        return doc

    install_openapi(app, "online")

    if packaged_release:
        async def removed_stable_static():
            raise HTTPException(
                404,
                _err("not_found", "stable release asset aliases are disabled"),
                headers={"Cache-Control": "no-store"},
            )

        for route in ("/projection", "/projection/{path:path}", "/assets", "/assets/{path:path}"):
            app.add_api_route(
                route,
                removed_stable_static,
                methods=["GET", "HEAD"],
                include_in_schema=False,
            )
    if projection_dir is not None and projection_dir.is_dir():
        app.mount(
            projection_base,
            StaticFiles(directory=str(projection_dir)),
            name="projection",
        )
    if release_prefix and dist_dir is not None and (dist_dir / "assets").is_dir():
        app.mount(
            f"{release_prefix}/dist/assets",
            StaticFiles(directory=str(dist_dir / "assets")),
            name="release-assets",
        )
    if dist_dir is not None and dist_dir.is_dir():
        from ..server import _SpaStaticFiles
        app.mount("/", _SpaStaticFiles(directory=str(dist_dir), html=True), name="spa")

    # Online worker strategy (§8): UNLIKE the resident local pool, reclaim idle query workers so
    # the QA box does not hold dex/meta subprocesses against Nextcloud's memory. A lightweight
    # background tick reaps workers idle past the threshold; the next request lazily respawns.
    if idle_reap_seconds and hasattr(pool, "reap_idle"):
        reaper: dict[str, asyncio.Task] = {}

        @app.on_event("startup")
        async def _start_reaper() -> None:
            cadence = min(60.0, float(idle_reap_seconds))

            async def loop() -> None:
                try:
                    while True:
                        await asyncio.sleep(cadence)
                        await asyncio.to_thread(pool.reap_idle, idle_reap_seconds)
                except asyncio.CancelledError:
                    pass
            reaper["task"] = asyncio.create_task(loop())

        @app.on_event("shutdown")
        async def _stop_reaper() -> None:
            t = reaper.get("task")
            if t is not None:
                t.cancel()
            if hasattr(pool, "shutdown"):
                await asyncio.to_thread(pool.shutdown)

    return app
