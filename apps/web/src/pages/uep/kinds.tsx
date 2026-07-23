/** Shared bits of the UEP panel chunk: kind badges + payload pretty-printing. Artifact
 * payloads are agent-authored skill JSON the panel must NOT re-validate (design §4.2 keeps
 * them verbatim) — rendering is best-effort, the raw text is always the fallback. */
import { UEP_GATE_KINDS, type UepGateKind } from "@pokemon-champions/protocol";
import { optionalKey, useT, type MsgKey } from "../../i18n.ts";

const KIND_KEYS: Record<UepGateKind, MsgKey> = {
  "intake": "kind.intake",
  "context": "kind.context",
  "audit": "kind.audit",
  "frame": "kind.frame",
  "slate": "kind.slate",
  "checkpoint": "kind.checkpoint",
  "decision": "kind.decision",
  "draft": "kind.draft",
  "answer-audit": "kind.answer-audit",
};

export const isGateKind = (kind: string): kind is UepGateKind =>
  (UEP_GATE_KINDS as readonly string[]).includes(kind);

export function KindBadge({ kind }: { kind: string }) {
  const t = useT();
  const extra = optionalKey(`kind.${kind}`);
  const label = isGateKind(kind) ? t(KIND_KEYS[kind]) : extra ? t(extra) : kind;
  return <span className={`uep-kind uep-kind-${isGateKind(kind) ? kind : "other"}`}>{label}</span>;
}

/** Pretty-print a payload for DISPLAY only (the stored artifact stays verbatim). */
export function prettyPayload(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
