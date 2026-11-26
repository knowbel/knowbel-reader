import { showNotice } from "../components/notices";
import type { DivePanel } from "../deepdive/types";
import type { NotebookCapture } from "./model";
import type { NotebookStore } from "./store";

export async function saveNotebookExcerpt(store: NotebookStore, text: string, options: Partial<NotebookCapture> = {}) {
  const docId = store.docId;
  const { parseRichMarkdown } = await import("./codec");
  if (store.docId !== docId) return;
  const body = options.conversationId || options.sources?.length ? parseRichMarkdown(text, options.sources) : undefined;
  const previous = new Set(store.getSnapshot().entries.map((entry) => entry.id));
  const id = store.addExcerpt(text, options, body);
  showNotice(previous.has(id) ? "Already in notebook." : "Added to notebook.", [{ label: "Show", run: () => store.reveal(id) }, ...(!previous.has(id) ? [{ label: "Undo", run: () => store.trash(id) }] : [])]);
  return id;
}

export async function saveDiveSummary(store: NotebookStore, root: DivePanel, summary: NonNullable<DivePanel["summary"]>) {
  const context = `Dive summary · ${root.label}`;
  const highlights = root.anchorHighlightId ? [] : store.getSnapshot().captures.filter((capture) =>
    capture.kind === "native" && capture.native?.kind === "highlight" && capture.conversationId === root.id);
  const captureId = root.anchorHighlightId ? `pdf:${root.anchorHighlightId}` : (highlights.find((capture) => capture.visible) ?? highlights[0])?.id;
  if (!captureId) return saveNotebookExcerpt(store, summary.content, {
    context, sources: summary.sources, conversationId: root.id, position: root.pageNumber, locationLabel: root.locationLabel,
  });

  const docId = store.docId;
  const { parseRichMarkdown } = await import("./codec");
  if (store.docId !== docId) return;
  const saved = store.addDiveSummary(captureId, summary.content, parseRichMarkdown(summary.content, summary.sources), {
    kind: "ai", context, conversationId: root.id, sources: summary.sources,
  });
  if (!saved) {
    showNotice("Restore the highlighted passage in Notebook before saving the summary.");
    return;
  }
  showNotice(saved.added ? "Summary saved under the highlighted passage." : "This summary is already saved under the highlighted passage.", [
    { label: "Show", run: () => { if (store.docId === docId) store.reveal(saved.id); } },
  ]);
  return saved.id;
}
