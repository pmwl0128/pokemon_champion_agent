/** The library workspace: the reader's teams and boxes as one app-level object that any page can
 * reach (frontend/design.md §2.4). The shell owns it, so it survives navigation.
 *
 * Pages never open the library themselves. They say what they can take — "our team", "one more
 * attacker", "the owned list" — as receivers, and what they can give — "the team on screen" — as
 * sources. The dock lists those beside the reader's selection, and a drop onto a page's drop zone
 * reaches the same receiver. Neither side knows the other: the dock knows no page, a page knows
 * no storage. This module is in the entry bundle, so it holds no storage code (Dexie loads with
 * the dock and the teams page only). */
import type { FormatId, TeamDoc, TeamMemberDoc } from "@pokemon-champions/protocol";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useLayoutEffect, useSyncExternalStore,
  type DragEvent, type ReactNode,
} from "react";
import { useToast } from "../../components/Toast.tsx";
import { useT } from "../../i18n.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { LibraryOrigin } from "./records.ts";

/** What travels from the library to a page. Names are dex canonical English, like everywhere. */
export type LibraryPayload =
  | { kind: "team"; doc: TeamDoc; name: string }
  /** `boxId` when the Pokémon comes out of the library itself, so a drop inside the library moves it. */
  | { kind: "pokemon"; member: TeamMemberDoc; name: string; boxId?: string }
  /** The whole box as a species list (a builder's "owned" pool). */
  | { kind: "box"; species: string[] };
export type LibraryKind = LibraryPayload["kind"];
type PayloadOf<K extends LibraryKind> = Extract<LibraryPayload, { kind: K }>;

/** A refusal carries the page's own reason ("that side already holds six"); success may add one. */
export type ReceiveResult = { ok: true; message?: string } | { ok: false; message: string };

export interface LibraryReceiver<K extends LibraryKind = LibraryKind> {
  /** Unique on the page, stable across renders. */
  id: string;
  kind: K;
  /** The action as the reader reads it: "Fill our team". */
  label: string;
  receive: (payload: PayloadOf<K>) => ReceiveResult;
}
export type AnyReceiver = { [K in LibraryKind]: LibraryReceiver<K> }[LibraryKind];

export type LibrarySource =
  | { id: string; origin: LibraryOrigin; kind: "team"; label: string; read: () => TeamDoc | null }
  | { id: string; origin: LibraryOrigin; kind: "pokemon"; label: string; read: () => TeamMemberDoc | null };

/** The team the reader is working with, remembered without opening the library: its id and format.
 * The library clears it when the team is deleted (`useActiveTeamSync`). */
export interface ActiveTeam {
  id: string;
  format: FormatId;
}

/** Drag data type of a library payload. Plain text travels beside it, so a drop into any text
 * field still yields something readable. */
export const LIBRARY_MIME = "application/x-pc-library";
const ACTIVE_KEY = "pcui-active-team";
const BOX_KEY = "pcui-current-box";

interface WorkspaceApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  receivers: AnyReceiver[];
  sources: LibrarySource[];
  register: (receiver: AnyReceiver) => () => void;
  offer: (source: LibrarySource) => () => void;
  active: ActiveTeam | null;
  setActive: (team: ActiveTeam | null) => void;
  /** What is being dragged out of the library right now, so drop zones can light up. */
  dragging: LibraryKind | null;
  setDragging: (kind: LibraryKind | null) => void;
  /** Hand a payload to a receiver and tell the reader how it went. */
  deliver: (receiver: AnyReceiver, payload: LibraryPayload) => ReceiveResult;
  /** The box the reader has in view (the dock's, the teams page's): where "keep" puts a Pokémon. */
  currentBox: number;
  setCurrentBox: (box: number) => void;
  /** Keep one Pokémon in the current box, or the next free cell after it; says so with an undo.
   * Resolves to the box it went into, or null when every box is full (or the store refused). */
  keepMon: (member: TeamMemberDoc, origin: LibraryOrigin, name: string) => Promise<{ box: string } | null>;
  /** A page's own "save team" control: opens the dock on the save dialog for that registered team
   * source. The dock takes the request and clears it. */
  saveRequest: string | null;
  requestSave: (sourceId: string | null) => void;
}

interface WorkspaceStore {
  value: WorkspaceApi;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
}
const WorkspaceContext = createContext<WorkspaceStore | null>(null);

function readActive(): ActiveTeam | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null") as ActiveTeam | null;
    return raw && typeof raw.id === "string" && (raw.format === "single" || raw.format === "double")
      ? { id: raw.id, format: raw.format } : null;
  } catch {
    return null;
  }
}

function readBox(): number {
  try {
    const value = Number(localStorage.getItem(BOX_KEY));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function LibraryWorkspaceProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const t = useT();
  const { capabilities } = useRuntime();
  const [currentBox, setCurrentBoxState] = useState(readBox);
  const [open, setOpen] = useState(false);
  const [receivers, setReceivers] = useState<AnyReceiver[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [active, setActiveState] = useState<ActiveTeam | null>(readActive);
  const [dragging, setDragging] = useState<LibraryKind | null>(null);
  const [saveRequest, setSaveRequest] = useState<string | null>(null);
  const requestSave = useCallback((sourceId: string | null) => {
    setSaveRequest(sourceId);
    if (sourceId) setOpen(true);
  }, []);

  const register = useCallback((receiver: AnyReceiver) => {
    setReceivers((list) => [...list.filter((item) => item.id !== receiver.id), receiver]);
    return () => setReceivers((list) => list.filter((item) => item !== receiver));
  }, []);
  const offer = useCallback((source: LibrarySource) => {
    setSources((list) => [...list.filter((item) => item.id !== source.id), source]);
    return () => setSources((list) => list.filter((item) => item !== source));
  }, []);
  const setActive = useCallback((team: ActiveTeam | null) => {
    setActiveState(team);
    try {
      if (team) localStorage.setItem(ACTIVE_KEY, JSON.stringify(team));
      else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* storage blocked — the choice lasts for this page view */ }
  }, []);
  const deliver = useCallback((receiver: AnyReceiver, payload: LibraryPayload): ReceiveResult => {
    const result = payload.kind === receiver.kind
      ? (receiver.receive as (value: LibraryPayload) => ReceiveResult)(payload)
      : { ok: false as const, message: receiver.label };
    toast({ text: result.ok ? result.message ?? t("library.filled").replace("{label}", receiver.label) : result.message });
    return result;
  }, [toast, t]);

  const setCurrentBox = useCallback((box: number) => {
    setCurrentBoxState(box);
    try { localStorage.setItem(BOX_KEY, String(box)); } catch { /* the choice lasts for this view */ }
  }, []);

  const currentBoxRef = useRef(currentBox);
  currentBoxRef.current = currentBox;
  const { season, rule, asOf } = capabilities.environment;
  const deploymentId = capabilities.deploymentId;
  const keepMon = useCallback(async (member: TeamMemberDoc, origin: LibraryOrigin, name: string)
    : Promise<{ box: string } | null> => {
    try {
      // The storage code loads on the first keep, not with the page.
      const repo = await import("./repo.ts");
      const record = await repo.addToBox(member, {
        origin, snapshot: { season: season ?? null, rule: rule ?? null, asOf: asOf ?? null, deploymentId: deploymentId ?? null },
      }, { box: currentBoxRef.current, slot: 0 });
      if (!record) { toast({ text: t("library.full") }); return null; }
      const { layout } = await repo.loadLibrary();
      const box = layout.boxes[record.box]?.name || (record.box === 0 ? t("lib.box.defaultSingle")
        : record.box === 1 ? t("lib.box.defaultDouble") : t("lib.box.name").replace("{n}", String(record.box + 1)));
      toast({
        text: t("library.kept").replace("{box}", box).replace("{name}", name),
        action: { label: t("library.undo"), run: () => void repo.removeBoxRecord(record.id) },
      });
      return { box };
    } catch {
      toast({ text: t("library.failed") });
      return null;
    }
  }, [season, rule, asOf, deploymentId, toast, t]);

  const value = useMemo<WorkspaceApi>(() => ({
    open, setOpen, receivers, sources, register, offer, active, setActive, dragging, setDragging, deliver,
    currentBox, setCurrentBox, keepMon, saveRequest, requestSave,
  }), [open, receivers, sources, register, offer, active, setActive, dragging, deliver, currentBox, setCurrentBox,
    keepMon, saveRequest, requestSave]);
  const [store] = useState<WorkspaceStore>(() => {
    const listeners = new Set<() => void>();
    return { value, listeners, subscribe: (listener) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } };
  });
  useLayoutEffect(() => {
    store.value = value;
    store.listeners.forEach((listener) => listener());
  }, [store, value]);
  return <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>;
}

/** Subscribe only to the fields a consumer reads. Registering a source, dragging or opening the
 * dock must not invalidate every page that merely uses an action. */
export function useLibraryWorkspace<K extends keyof WorkspaceApi = keyof WorkspaceApi>(...keys: K[]): Pick<WorkspaceApi, K> {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error("useLibraryWorkspace outside LibraryWorkspaceProvider");
  const signature = keys.join(",");
  const getSnapshot = useMemo(() => {
    const selected = (signature ? signature.split(",") : Object.keys(store.value)) as K[];
    let cached: Pick<WorkspaceApi, K> | undefined;
    return () => {
      if (!cached || selected.some((key) => cached![key] !== store.value[key])) {
        cached = Object.fromEntries(selected.map((key) => [key, store.value[key]])) as Pick<WorkspaceApi, K>;
      }
      return cached;
    };
  }, [store, signature]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** Offer a receiver while the calling component is mounted (and `receiver` is not null). The
 * receiver may be a fresh object every render; only its id, kind and label re-register it — its
 * `receive` is always the latest one. */
export function useLibraryReceiver<K extends LibraryKind>(receiver: LibraryReceiver<K> | null): void {
  const { register } = useLibraryWorkspace("register");
  const latest = useRef(receiver);
  latest.current = receiver;
  const id = receiver?.id;
  const kind = receiver?.kind;
  const label = receiver?.label;
  useEffect(() => {
    if (!id || !kind || !label) return;
    const proxy = {
      id, kind, label,
      receive: (payload: LibraryPayload) =>
        (latest.current?.receive as ((value: LibraryPayload) => ReceiveResult) | undefined)?.(payload)
          ?? { ok: false as const, message: label },
    } as AnyReceiver;
    return register(proxy);
  }, [register, id, kind, label]);
}

/** Offer a source (something on the page the library can keep) while mounted, same rules. */
export function useLibrarySource(source: LibrarySource | null): void {
  const { offer } = useLibraryWorkspace("offer");
  const latest = useRef(source);
  latest.current = source;
  const id = source?.id;
  const kind = source?.kind;
  const label = source?.label;
  const origin = source?.origin;
  useEffect(() => {
    if (!id || !kind || !label || !origin) return;
    const proxy = { id, kind, label, origin, read: () => latest.current?.read() ?? null } as LibrarySource;
    return offer(proxy);
  }, [offer, id, kind, label, origin]);
}

/** Drop-zone props for a part of the page: a library payload dropped here goes to the first of
 * `receiverIds` that takes its kind. While something droppable is being dragged the zone carries
 * `data-library-drop="ready"` (and `"over"` under the pointer) for styling. */
export function useLibraryDrop(receiverIds: string[]) {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error("useLibraryDrop outside LibraryWorkspaceProvider");
  const node = useRef<HTMLElement | null>(null);
  const over = useRef(false);
  const ids = useRef(receiverIds);
  ids.current = receiverIds;
  const targets = () => store.value.receivers.filter((receiver) => ids.current.includes(receiver.id));
  const accepts = () => targets().some((receiver) => receiver.kind === store.value.dragging);
  const paint = () => {
    if (!store.value.dragging) over.current = false;
    if (!node.current) return;
    if (accepts()) node.current.dataset.libraryDrop = over.current ? "over" : "ready";
    else delete node.current.dataset.libraryDrop;
  };
  const latestPaint = useRef(paint);
  latestPaint.current = paint;
  useLayoutEffect(() => {
    latestPaint.current();
    return store.subscribe(() => latestPaint.current());
  }, [store]);
  return {
    ref: (element: HTMLElement | null) => { node.current = element; paint(); },
    onDragOver: (event: DragEvent) => {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      over.current = true;
      paint();
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { over.current = false; paint(); }
    },
    onDrop: (event: DragEvent) => {
      const raw = event.dataTransfer.getData(LIBRARY_MIME);
      if (!raw) return;
      event.preventDefault();
      over.current = false;
      paint();
      try {
        const payload = JSON.parse(raw) as LibraryPayload;
        const target = targets().find((receiver) => receiver.kind === payload.kind);
        if (target) store.value.deliver(target, payload);
      } catch { /* not ours after all */ }
    },
  };
}

/** Drag props for something on a page the library can keep (a team member card, say): dropping it on
 * a box cell of the dock puts it there. `payload` is read when the drag starts. */
export function useLibraryDragSource(payload: () => LibraryPayload | null, text: () => string) {
  const { setDragging } = useLibraryWorkspace("setDragging");
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      const value = payload();
      if (!value) { event.preventDefault(); return; }
      event.dataTransfer.setData(LIBRARY_MIME, JSON.stringify(value));
      event.dataTransfer.setData("text/plain", text());
      event.dataTransfer.effectAllowed = "copyMove";
      setDragging(value.kind);
    },
    onDragEnd: () => setDragging(null),
  };
}
