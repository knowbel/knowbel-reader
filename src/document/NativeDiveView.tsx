import { useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import DeepDiveView from "../deepdive/DeepDiveView";
import type { SendOptions } from "../deepdive/DivePanelPane";
import { newThread, type AskContext } from "../ask/job";
import { useAskThreads, type AskStore } from "../ask/store";
import type { AskThread } from "../ask/types";
import type { DocumentEngine } from "./engine";
import type { NotebookStore } from "../notebook/store";
import { useDiveMarks } from "../notebook/store";
import type { DiveHighlight, DiveHighlightPlacement } from "../deepdive/types";
import type { ResolvedRef } from "../grounding/CitationChip";
import { addAttachment, makeAttachment, type Attachment } from "../grounding/attachments";
import { saveNotebookExcerpt } from "../notebook/capture";
import { streamDiveReply } from "../deepdive/api";
import { buildTreeSummaryRequest, treeAnswerCount, treeRevision } from "../deepdive/summary";
import { openingMessage } from "../deepdive/prompts";
import { nativeDivePanels, nativeSummaryStore, sendNativeDive } from "./nativeDives";

export default function NativeDiveView({ store, engine, notebook, getContext, controllers, focusId, onFocus, onReturn, rootSlotRef, onJumpToSource, onJob, highlightFocusId }: {
  store: AskStore; engine: DocumentEngine; notebook: NotebookStore; getContext: () => AskContext; controllers: Map<string, AbortController>;
  focusId: string; onFocus: (id: string | null) => void; onReturn: (id: string) => void; rootSlotRef: RefObject<HTMLDivElement>;
  onJumpToSource: (ref: ResolvedRef) => void; onJob: (job: Promise<void>) => void; highlightFocusId: string | null;
}) {
  const threads = useAskThreads(store);
  const { panels, jobs } = useMemo(() => nativeDivePanels(threads, engine), [threads, engine]);
  const highlights = useDiveMarks(notebook);
  useSyncExternalStore(notebook.drafts!.subscribe, notebook.drafts!.getRevision);
  const summaryState = useMemo(() => nativeSummaryStore(store), [store]);
  const summaryJobs = useSyncExternalStore(summaryState.subscribe, summaryState.getSnapshot);
  const setSummaryJobs = summaryState.set;
  const scrollPositions = useRef(new Map<string, number>());
  const attachments = notebook.drafts!.attachmentMap("dive:");
  const setAttachments = (id: string, values: Attachment[]) => notebook.drafts!.setAttachments(`dive:${id}`, values);
  const send = async (id: string, question: string, _onChunk?: (chunk: string) => void, options: SendOptions = {}) => {
    const attached = options.attachments ?? attachments[id] ?? [];
    setAttachments(id, []);
    const work = sendNativeDive(store, id, question, getContext(), controllers, { ...options, attachments: attached }, _onChunk);
    onJob(work); await work;
  };
  const nested = (parentId: string, selection: string, contextText: string, placement: DiveHighlightPlacement = {}) => {
    const parent = store.get(parentId);
    const existing = threads.find((thread) => thread.parentThreadId === parentId && thread.selection === selection && thread.placement?.turnIndex === placement.turnIndex && thread.placement?.occurrence === placement.occurrence);
    if (existing) { onFocus(existing.id); return existing.id; }
    const child: AskThread = { ...newThread(selection), mode: "dive", parentThreadId: parentId, selection, contextText, anchor: parent?.anchor, placement, inheritedSources: parent?.turns[placement.turnIndex ?? -1]?.sources };
    store.add(child); onFocus(child.id);
    const attachment = makeAttachment("answer", `${selection}\n\nEarlier explanation:\n${contextText.slice(0, 10000)}`);
    void send(child.id, openingMessage(selection), undefined, { attachments: attachment ? [attachment] : [] });
    return child.id;
  };
  const summarize = async (rootId: string) => {
    const key = `summary:${rootId}`;
    if (controllers.has(key)) return;
    const controller = new AbortController(); controllers.set(key, controller);
    const request = buildTreeSummaryRequest({ fileName: engine.document.title, panels, rootId, pageLabel: (unit) => engine.labelForUnit(unit) });
    setSummaryJobs((jobs) => ({ ...jobs, [rootId]: { phase: "streaming", text: "", sources: request.sources } }));
    const work = (async () => {
      let text = "";
      try {
        const context = getContext();
        const content = await streamDiveReply({ system: request.system, messages: [{ role: "user", content: request.prompt }], signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
          onText: (chunk) => { text += chunk; setSummaryJobs((jobs) => ({ ...jobs, [rootId]: { phase: "streaming", text, sources: request.sources } })); } });
        if (controller.signal.aborted) return;
        store.update(rootId, (thread) => ({ ...thread, summary: { content, sources: request.sources, at: new Date().toISOString(), turnCount: treeAnswerCount(panels, rootId), revision: treeRevision(panels, rootId) } }));
        setSummaryJobs((jobs) => { const next = { ...jobs }; delete next[rootId]; return next; });
      } catch (error) { setSummaryJobs((jobs) => ({ ...jobs, [rootId]: { phase: controller.signal.aborted ? "cancelled" : "error", text, sources: request.sources, error: controller.signal.aborted ? "Summary stopped." : String(error) } })); }
      finally { controllers.delete(key); }
    })(); onJob(work); await work;
  };
  return <DeepDiveView panels={panels} jobs={jobs} summaryJobs={summaryJobs} onCancel={(id) => controllers.get(id)?.abort()}
    onCancelSummary={(id) => controllers.get(`summary:${id}`)?.abort()} onReturnToPassage={onReturn} scrollPositions={scrollPositions.current}
    diveHighlights={highlights} scrolledToDiveHighlightId={highlightFocusId} focusId={focusId} rootLabel={engine.document.title} onFocusChange={onFocus}
    rootSlotRef={rootSlotRef} onSendMessage={send} onNestedDive={({ parentId, selection, contextText, ...placement }) => { nested(parentId, selection, contextText, placement); }}
    onSuggestedDive={({ parentId, turnIndex, suggestion }) => { const turn = store.get(parentId)?.turns[turnIndex]; nested(parentId, suggestion.text, turn?.content ?? "", { turnIndex }); }}
    onSummarizeTree={summarize} pageLabel={(unit) => engine.labelForUnit(unit)} onJumpToSource={onJumpToSource} attachments={attachments}
    onAddToQuestion={(id, kind, text) => { const attachment = makeAttachment(kind, text); if (attachment) setAttachments(id, addAttachment(attachments[id] ?? [], attachment)); }}
    onRemoveAttachment={(id, attachmentId) => setAttachments(id, (attachments[id] ?? []).filter((attachment) => attachment.id !== attachmentId))} onClearAttachments={(id) => setAttachments(id, [])}
    onAddHighlight={(panelId, text, comment, style) => notebook.captureDive({ panelId, text, comment, ...style })}
    onEditHighlight={(id, edit) => notebook.setDiveHighlights((highlights) => highlights.map((highlight) => highlight.id === id ? { ...highlight, ...edit } : highlight))}
    onDeleteHighlight={(id) => notebook.setDiveHighlights((highlights) => highlights.filter((highlight) => highlight.id !== id))}
    onDiveFromHighlight={(highlight: DiveHighlight, contextText) => {
      if (highlight.divePanelId) { onFocus(highlight.divePanelId); return; }
      const id = nested(highlight.panelId, highlight.text, contextText, highlight);
      notebook.setDiveHighlights((highlights) => highlights.map((item) => item.id === highlight.id ? { ...item, divePanelId: id } : item));
    }} onPin={(text, context) => void saveNotebookExcerpt(notebook, text, { context })} />;
}
