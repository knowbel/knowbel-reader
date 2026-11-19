import type { AskContext } from "../ask/job.ts";
import type { SendOptions } from "../deepdive/DivePanelPane.tsx";
import type { AskStore } from "../ask/store.ts";
import type { AskThread } from "../ask/types.ts";
import type { DiveJobState, DivePanel, SummaryJobState } from "../deepdive/types.ts";
import type { DocumentEngine } from "./engine.ts";
import { anchorText } from "./anchors.ts";

type SummaryJobs = Record<string, SummaryJobState>;
function summaryStore() {
  let snapshot: SummaryJobs = {};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (change: (previous: SummaryJobs) => SummaryJobs) => { snapshot = change(snapshot); listeners.forEach((listener) => listener()); },
  };
}
const summaries = new WeakMap<AskStore, ReturnType<typeof summaryStore>>();
// Progress belongs to the document, so closing the dive view cannot lose a
// running summary or hide its cancel/retry controls when it is opened again.
export function nativeSummaryStore(store: AskStore) {
  let state = summaries.get(store);
  if (!state) { state = summaryStore(); summaries.set(store, state); }
  return state;
}

// Saved native threads remain canonical, preserving older conversation IDs
// and Notebook links. The shared Deep Dive view consumes this projection.
export function nativeDivePanels(threads: AskThread[], engine: DocumentEngine): { panels: DivePanel[]; jobs: Record<string, DiveJobState> } {
  const jobs: Record<string, DiveJobState> = {};
  const dives = threads.filter((thread) => thread.mode === "dive");
  const ids = new Set(dives.map((thread) => thread.id));
  const panels = dives.map((thread): DivePanel => {
    const streaming = thread.turns.find((turn) => turn.status === "streaming");
    if (streaming) jobs[thread.id] = { phase: "streaming", text: streaming.content, sources: streaming.sources };
    return { id: thread.id, parentId: thread.parentThreadId && ids.has(thread.parentThreadId) && thread.parentThreadId !== thread.id ? thread.parentThreadId : null, anchorHighlightId: null,
      selection: thread.selection ?? (thread.anchor ? anchorText(engine.document, thread.anchor) : thread.title),
      selectionImage: thread.selectionImage, label: thread.title.slice(0, 60), contextText: thread.contextText ?? "",
      ...(thread.anchor ? { pageNumber: engine.unitForAnchor(thread.anchor), locationLabel: engine.labelForUnit(engine.unitForAnchor(thread.anchor)) } : {}),
      turns: thread.turns.filter((turn) => turn.status !== "streaming").map((turn) => ({ id: turn.id, role: turn.role, content: turn.content, at: turn.at, sources: turn.sources, attachments: turn.attachments, suggestions: turn.suggestions, diagram: turn.diagram, ...(turn.status === "error" ? { status: "error" as const, error: turn.content } : {}) })),
      createdAt: thread.createdAt, summary: thread.summary, baseSources: thread.baseSources, sourceRegistry: thread.sourceRegistry, inheritedSources: thread.inheritedSources,
    };
  });
  return { panels, jobs };
}

export async function sendNativeDive(store: AskStore, id: string, question: string, context: AskContext, controllers: Map<string, AbortController>, options?: SendOptions, onChunk?: (chunk: string) => void) {
  if (controllers.has(id)) return;
  const controller = new AbortController(); controllers.set(id, controller);
  try { const { runNativeDive } = await import("./nativeDiveJob.ts"); await runNativeDive(store, id, question, { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal }, options, onChunk); }
  finally { if (controllers.get(id) === controller) controllers.delete(id); }
}
