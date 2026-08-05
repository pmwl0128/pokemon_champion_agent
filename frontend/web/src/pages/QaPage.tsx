/** Fact QA (llm.qa, design §7.2): ONE question -> ONE tool-grounded answer. Every question
 * is independent — no conversation history is ever sent to the model or stored server-side
 * (the page says so up front). The answer names entities by English canonical (same
 * contract as agent prose), so it renders through the prose entity renderer and localizes
 * with dex authority. What DOES persist is browser-session continuity (§7.4: form state
 * lives client-side): the input and the answers asked in this tab are kept in
 * sessionStorage, so navigating away and back doesn't wipe them. Online runtime only:
 * the route/nav are capability-gated and this chunk is lazy. */
import type { QaAnswerDto } from "@pokemon-champions/protocol";
import { QA_QUESTION_MAX_CHARS } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { optionalKey, useLang, useT } from "../i18n.ts";
import { useProseRenderer } from "../lib/prose.tsx";
import { HttpError } from "../runtime/adapter.ts";
import { useRuntime } from "../runtime/context.tsx";

type ErrorKind = "limit" | "busy" | "unavailable" | "generic";

/** The endpoint's error DETAIL codes ride inside HttpError's message (fetchJson keeps the
 * body's `detail` verbatim there) — enough to pick the right copy without a second wire shape. */
function errorKind(e: unknown): ErrorKind {
  if (!(e instanceof HttpError)) return "generic";
  if (e.status === 429) return e.message.includes("rate_limited") ? "limit" : "busy";
  if (e.status === 503) return "unavailable";
  return "generic";
}

const EXAMPLE_KEYS = ["qa.ex1", "qa.ex2", "qa.ex3"] as const;

interface HistoryEntry {
  q: string;
  a: QaAnswerDto;
}

const QA_STORE_KEY = "pc-qa";
const QA_HISTORY_CAP = 10;

interface QaStash {
  question?: string;
  history?: HistoryEntry[];
}

function readQaStash(): QaStash {
  try {
    return JSON.parse(sessionStorage.getItem(QA_STORE_KEY) ?? "{}") as QaStash;
  } catch {
    return {};
  }
}

function writeQaStash(s: QaStash): void {
  try {
    sessionStorage.setItem(QA_STORE_KEY, JSON.stringify(s));
  } catch { /* storage blocked — continuity just won't survive navigation */ }
}

/** The in-flight question, held OUTSIDE React (same shape as the diagnose tab's active task).
 * A QA round trip is many seconds of tool rounds, and switching tabs unmounts this page — with the
 * promise owned only by the component, every `setState` after the await became a no-op and the
 * answer the user already paid for was dropped on the floor. Module scope outlives the unmount, so
 * `ask` still persists the answer and a remount re-attaches to the same promise. */
interface ActiveQaTask {
  promise: Promise<QaAnswerDto>;
  question: string;
}
let activeQaTask: ActiveQaTask | null = null;

/** Prepend an answer to the STASH rather than to React state: the writer may be running while the
 * page is unmounted, when the state updater would never fire. */
function recordAnswer(entry: HistoryEntry): HistoryEntry[] {
  const prev = readQaStash();
  const history = [entry, ...(prev.history ?? [])].slice(0, QA_HISTORY_CAP);
  writeQaStash({ ...prev, history });
  return history;
}

function AnswerCard({ entry, quotaLine }: { entry: HistoryEntry; quotaLine: boolean }) {
  const t = useT();
  const { lang } = useLang();
  const prose = useProseRenderer();
  const traceLabel = (source: QaAnswerDto["toolTrace"][number]): string => {
    if (!source.params) return lang === "en" ? source.label : t("qa.trace.generic");
    const key = source.tool.startsWith("dex.")
      ? `qa.trace.dex.${source.tool.slice(4)}` : `qa.trace.${source.tool}`;
    const msgKey = optionalKey(key);
    const translated = msgKey ? t(msgKey) : source.label;
    const params = { ...source.params };
    if (params.format === "single" || params.format === "double") {
      params.format = t(`format.${params.format}`);
    }
    return translated.replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
  };
  return (
    <div className={`panel result-panel qa-answer${entry.a.grounded ? "" : " ungrounded"}`}>
      <div className="qa-asked muted">{entry.q}</div>
      {entry.a.answer.split(/\n+/).map((para, i) => (
        <p key={i} className="qa-answer-text">{prose(para)}</p>
      ))}
      {/* No tool grounded this reply → it's a decline/out-of-scope note, never a Champions
          fact. Say so, so the site's "backed by deterministic queries" promise isn't overclaimed. */}
      {!entry.a.grounded && (
        <p className="notice qa-ungrounded">{t("qa.ungrounded")}</p>
      )}
      {entry.a.toolTrace.length > 0 && (
        <div className="qa-sources">
          <span className="muted">{t("qa.sources")}</span>
          {entry.a.toolTrace.map((s, i) => (
            <span key={i} className="qa-source" title={s.tool}>{prose(traceLabel(s))}</span>
          ))}
        </div>
      )}
      {quotaLine && (
        <div className="qa-quota muted num">
          {t("qa.quota")} {entry.a.quota.limit === 0
            ? t("quota.unlimited")
            : `${entry.a.quota.used}/${entry.a.quota.limit}`}
        </div>
      )}
    </div>
  );
}

export function QaPage() {
  const { adapter } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const stash = useMemo(readQaStash, []);
  const [question, setQuestion] = useState(stash.question ?? "");
  const [history, setHistory] = useState<HistoryEntry[]>(stash.history ?? []);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<ErrorKind | null>(null);

  useEffect(() => {
    writeQaStash({ question, history });
  }, [question, history]);

  // Re-attach to a question still in flight from an earlier mount of this page.
  useEffect(() => {
    const task = activeQaTask;
    if (!task) return;
    let live = true;
    setAsking(true);
    setError(null);
    task.promise.then(() => {
      if (live) setHistory(readQaStash().history ?? []);
    }, (reason: unknown) => {
      if (live) setError(errorKind(reason));
    }).finally(() => {
      if (live) setAsking(false);
    });
    return () => { live = false; };
  }, []);

  const ask = async (raw?: string) => {
    const q = (raw ?? question).trim();
    if (!q || asking || activeQaTask || !adapter.qa) return;
    setAsking(true);
    setError(null);
    const promise = adapter.qa({ question: q.slice(0, QA_QUESTION_MAX_CHARS), lang });
    const task: ActiveQaTask = { promise, question: q };
    activeQaTask = task;
    try {
      // This continuation runs whether or not the page is still mounted, so the answer lands in
      // the stash either way; `setHistory` is just the live-view update.
      setHistory(recordAnswer({ q, a: await promise }));
    } catch (e) {
      setError(errorKind(e));
    } finally {
      if (activeQaTask === task) activeQaTask = null;
      setAsking(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("qa.title")} description={t("online.aiNote")} />
      <p className="notice page-disclosure">{t("qa.disclosure")}</p>

      <div className="panel form-panel qa-form">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          maxLength={QA_QUESTION_MAX_CHARS}
          rows={2}
          placeholder={t("qa.placeholder")}
          aria-label={t("qa.title")}
        />
        <div className="qa-actions">
          <span className="qa-examples">
            {EXAMPLE_KEYS.map((k) => (
              <button key={k} type="button" className="qa-example"
                      onClick={() => { setQuestion(t(k)); void ask(t(k)); }}>
                {t(k)}
              </button>
            ))}
          </span>
          <button type="button" className="primary-btn" disabled={asking}
                  onClick={() => void ask()}>
            {asking ? t("qa.asking") : t("qa.ask")}
          </button>
        </div>
      </div>

      {asking && <div className="spinner">{t("qa.asking")}</div>}
      {error && <p className="notice qa-error">{t(`qa.error.${error}`)}</p>}

      {history[0] !== undefined && <AnswerCard entry={history[0]} quotaLine />}

      {history.length > 1 && (
        <div className="qa-history">
          <div className="muted qa-history-title">{t("qa.history")}</div>
          {history.slice(1).map((entry, i) => (
            <AnswerCard key={`${entry.q}-${i}`} entry={entry} quotaLine={false} />
          ))}
        </div>
      )}
    </div>
  );
}
