/** UEP session list + creation (design §6). Local runtime only — this file lives in the
 * lazily-imported uep chunk behind the team.uep capability; the online runtime never
 * downloads it. The collaboration loop: the UI creates a session carrying the intent, the
 * user tells their agent to work on it, the agent submits artifacts via pcui. */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.tsx";
import { useAsync } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { KindBadge, localTime } from "./kinds.tsx";

export function SessionsPage() {
  const { adapter } = useRuntime();
  const t = useT();
  const navigate = useNavigate();
  const sessions = adapter.sessions;
  const [intent, setIntent] = useState("");
  const [format, setFormat] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const list = useAsync(
    () => (sessions ? sessions.list() : Promise.resolve([])), [sessions]);

  if (!sessions) return <div className="notice">{t("uep.unavailable")}</div>;

  const create = async () => {
    setCreating(true);
    setCreateError("");
    try {
      const meta: Record<string, unknown> = {};
      if (intent.trim()) meta.intent = intent.trim();
      if (format) meta.format = format;
      const s = await sessions.create(meta);
      navigate(`/sessions/${s.id}`);
    } catch (e) {
      console.error("Session creation failed:", e);
      setCreateError(t("uep.submitError"));
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader title={t("uep.title")} description={t("uep.howto")} />

      <div className="sessions-layout">
        <section className="panel uep-create">
          <header className="uep-create-head">
            <h2>{t("uep.new")}</h2>
          </header>
          <div className="uep-form">
            <label>
              {t("uep.intent")}
              <textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder={t("uep.intentPh")}
                rows={6}
              />
            </label>
            <fieldset className="uep-format" aria-label={t("a11y.format")}>
              <legend>{t("uep.format")}</legend>
              <div className="uep-format-options">
                {(["single", "double"] as const).map((value) => (
                  <button type="button" role="radio" aria-checked={format === value}
                    key={value} className={`uep-format-option${format === value ? " on" : ""}`}
                    onClick={() => setFormat(value)}>
                    <span className="uep-format-radio" aria-hidden />
                    <span>{t(`format.${value}`)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {createError && <div className="notice">{createError}</div>}
          </div>
          <footer className="uep-create-actions">
              <button className="primary-btn" onClick={create} disabled={creating}>{t("uep.create")}</button>
          </footer>
        </section>

        <section className="panel sessions-index">
          <div className="sessions-section-head">
            <h2>{t("uep.recent")}</h2>
            {list.status === "ready" && <span className="muted num">{list.data.length}</span>}
          </div>
          {list.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
          {list.status === "error" && <div className="notice">{t("state.errorDetail")}</div>}
          {list.status === "ready" && (
            <>
              <div className="session-table-head" aria-hidden>
                <span>{t("uep.column.status")}</span>
                <span>{t("uep.column.request")}</span>
                <span>{t("uep.column.info")}</span>
                <span>{t("uep.column.stages")}</span>
              </div>
              {list.data.length === 0
                ? <div className="sessions-empty muted">{t("uep.empty")}</div>
                : <div className="session-list">
                  {list.data.map((s) => (
                    <Link key={s.id} to={`/sessions/${s.id}`} className="session-card">
                      <div className="session-status">
                        {/* Coarse two-state badge: list rows have heads only (no ledger order), so
                          * "awaiting decision" can't be told apart from "decision made" here — the
                          * detail page computes the precise stage. */}
                        <span className={`uep-chip ${s.heads["answer-audit"] ? "ok" : "warn"}`}>
                          {t(s.heads["answer-audit"] ? "uep.stage.doneBadge" : "uep.stage.workingBadge")}
                        </span>
                      </div>
                      <div className="session-intent">
                        {typeof s.meta.intent === "string" && s.meta.intent !== "" ? s.meta.intent : s.id}
                      </div>
                      <div className="session-info">
                        <span className="muted num">{localTime(s.createdAt)}</span>
                        <span className="mono muted session-id">{s.id}</span>
                      </div>
                      <div className="session-kinds">
                        {Object.keys(s.heads).map((k) => <KindBadge key={k} kind={k} />)}
                      </div>
                    </Link>
                  ))}
                </div>}
            </>
          )}
        </section>
      </div>
    </>
  );
}
