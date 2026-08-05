/**
 * Local UEP session DTOs (frontend/design.md §4.2/§6): the bridge's session/artifact store as the
 * SPA consumes it. Artifacts themselves stay OPAQUE here — the store round-trips the exact
 * bytes the agent submitted (audit receipts must be recoverable verbatim), so the panel
 * renders payloads best-effort and never re-validates skill-owned shapes. The only artifact
 * the WEB side authors is the checkpoint decision, so that one gets a real schema.
 */
import { z } from "zod";

/** Artifact kinds the UEP panel knows how to label/order (design §6 gate table). The wire
 * accepts ANY kind — an agent may introduce new kinds an older panel simply renders
 * generically. `decision` is the UI-authored answer to a `checkpoint` pause. */
export const UEP_GATE_KINDS = [
  "intake", "context", "audit", "frame", "slate", "checkpoint", "decision", "draft", "answer-audit",
] as const;
export type UepGateKind = (typeof UEP_GATE_KINDS)[number];

/** One append-only ledger row (session_artifacts). */
export const LedgerEntryDtoSchema = z.object({
  sequence: z.number().int().nonnegative(),
  kind: z.string().min(1),
  artifactHash: z.string().min(1),
  createdAt: z.string().min(1),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDtoSchema>;

/** Session row: current state = heads (kind -> artifact hash) + revision, updated together
 * under the store's single-row optimistic lock. */
export const SessionDtoSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  revision: z.number().int().nonnegative(),
  heads: z.record(z.string(), z.string()),
  meta: z.record(z.string(), z.unknown()),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

/** GET /api/sessions/{id} — the session plus its full ledger. */
export const SessionWithLedgerDtoSchema = SessionDtoSchema.extend({
  ledger: z.array(LedgerEntryDtoSchema),
});
export type SessionWithLedgerDto = z.infer<typeof SessionWithLedgerDtoSchema>;

/** Append result AND the SSE event body — one shape, emitted by the same store commit. */
export const ArtifactAppendEventDtoSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.string().min(1),
  artifactHash: z.string().min(1),
  revision: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
});
export type ArtifactAppendEventDto = z.infer<typeof ArtifactAppendEventDtoSchema>;

/** The checkpoint decision the panel writes back (kind="decision") when a checkpoint
 * artifact reports pause:true — the agent reads it on its next turn (design §6). */
export const CheckpointDecisionDtoSchema = z.object({
  gate: z.literal("checkpoint"),
  /** chooseCandidate: pick slate candidate `candidateIndex`; requestChanges: `note` says
   * what to change; proceed: keep converging with the agent's own judgment. */
  action: z.enum(["chooseCandidate", "requestChanges", "proceed"]),
  candidateIndex: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  decidedAt: z.string().min(1),
}).refine((d) => d.action !== "chooseCandidate" || d.candidateIndex !== undefined, {
  message: "chooseCandidate requires candidateIndex",
});
export type CheckpointDecisionDto = z.infer<typeof CheckpointDecisionDtoSchema>;
