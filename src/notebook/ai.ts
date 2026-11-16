import { AskStore } from "../ask/store";
import { ask, newThread, type AskContext } from "../ask/job";
import { streamAskReply } from "../deepdive/api";
import { makeAttachment, type Attachment } from "../grounding/attachments";
import { entryContext, findRichNode, type NotebookEntry } from "./model";
import type { NotebookBindings } from "./context";
import type { SourceRef } from "../grounding/types";

export function entryAttachments(bindings: NotebookBindings, entry: NotebookEntry): Attachment[] {
  const result: Attachment[] = [];
  for (const id of entry.captureIds) {
    const capture = bindings.store.getCapture(id); if (!capture) continue;
    if (bindings.attachmentsForCapture) { result.push(...bindings.attachmentsForCapture(capture)); continue; }
    for (const source of capture.sources ?? []) result.push({ id: crypto.randomUUID(), kind: "document", text: source.text, pageNumber: source.pageNumber, range: [source.start, source.end], location: source.location, locationLabel: source.locationLabel });
    if (capture.pdf && capture.position) {
      const attached = makeAttachment("document", capture.pdf.content?.text ?? capture.text, capture.position); if (attached) result.push(attached);
      if (capture.imageId) {
        const asset = bindings.store.getAssets().find((asset) => asset.id === capture.imageId);
        if (asset) result.push({ id: crypto.randomUUID(), kind: "region", text: capture.text, pageNumber: capture.position, image: { mediaType: asset.mediaType, data: asset.data } });
      }
    }
  }
  return result.slice(0, 5);
}

export async function runInlineQuestion(bindings: NotebookBindings, entryId: string, nodeId: string): Promise<void> {
  const store = bindings.store, entry = store.getEntry(entryId), context = bindings.getAskContext();
  const node = entry && findRichNode(entry.body, nodeId), question = String(node?.attrs?.question ?? "").trim();
  if (!entry || !node || !question || !context) return;
  const controller = store.startJob(nodeId);
  const docId = store.docId;
  const patch = (attrs: Record<string, unknown>) => { if (store.docId === docId && store.isCurrentJob(nodeId, controller)) store.patchNode(entryId, nodeId, attrs); };
  const abort = () => controller.abort(); context.signal?.addEventListener("abort", abort, { once: true });
  const previousAnswer = node.attrs?.answer ?? "";
  // Keep the previous result until the replacement is complete.
  patch({ status: "preparing", pendingAnswer: "", error: "", previousAnswer });
  const threadStore = new AskStore();
  threadStore.load([], () => {});
  const thread = newThread(question); threadStore.add(thread);
  const attached = node.attrs?.scope === "document" ? [] : entryAttachments(bindings, entry);
  const noteText = entryContext(entry.body, nodeId);
  // The reader's prose is context only, never a source citation.
  if (node.attrs?.scope !== "document" && noteText.trim()) attached.push({ id: crypto.randomUUID(), kind: "answer", text: noteText });
  let lastText = "", sources: SourceRef[] = [], lastUpdate = 0;
  const update = (force = false) => {
    const turn = threadStore.get(thread.id)?.turns.at(-1);
    if (turn?.role !== "assistant") return;
    if (turn.status !== "error") lastText = turn.content;
    sources = turn.sources ?? sources;
    if (!force && Date.now() - lastUpdate < 45) return;
    lastUpdate = Date.now();
    if (!controller.signal.aborted) patch({ status: "streaming", pendingAnswer: lastText, pendingSources: sources });
  };
  const unsubscribe = threadStore.subscribe(update);
  try {
    const scoped: AskContext = { ...context, signal: controller.signal };
    await ask(threadStore, thread.id, question, scoped, { attachments: attached.slice(0, 6) });
    const turn = threadStore.get(thread.id)?.turns.at(-1);
    if (controller.signal.aborted) patch({ status: "interrupted", pendingAnswer: lastText, error: "Stopped. You can retry when ready." });
    else if (turn?.status === "error") patch({ status: "error", pendingAnswer: lastText, error: turn.content.replace(/^⚠️\s*/, "") });
    else if (previousAnswer || node.attrs?.editedBody) patch({ status: "proposal", pendingAnswer: turn?.content ?? lastText, pendingSources: turn?.sources ?? sources, pendingAt: new Date().toISOString() });
    else patch({ status: "complete", answer: turn?.content ?? lastText, pendingAnswer: "", pendingSources: [], sources: turn?.sources ?? sources, at: new Date().toISOString(), editedBody: null });
  } catch (error) {
    patch({ status: controller.signal.aborted ? "interrupted" : "error", error: error instanceof Error ? error.message : "Couldn't answer this question.", pendingAnswer: lastText });
  } finally {
    unsubscribe(); context.signal?.removeEventListener("abort", abort); store.finishJob(nodeId, controller);
    void store.flush().catch(() => {});
  }
}

export async function writingProposal(text: string, operation: "clarify" | "shorten", sources: SourceRef[], signal: AbortSignal): Promise<string> {
  const system = `Help a reader develop a technical notebook. ${operation === "clarify" ? "Clarify the selected writing while preserving its meaning and technical qualifications." : "Make the selected writing concise while preserving its meaning and technical qualifications."} Return only the proposed Markdown. Preserve equations, code, and valid citation markers. Never add a new factual claim or invent a citation. Reader writing and AI explanations are context, not independent source evidence.\nAvailable source references:\n${sources.map((source) => `[${source.label}] ${source.text.slice(0, 1500)}`).join("\n")}`;
  return streamAskReply({ system, messages: [{ role: "user", content: text.slice(0, 12000) }], signal, onText: () => {} });
}
