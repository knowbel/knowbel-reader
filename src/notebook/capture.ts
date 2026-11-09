import { showNotice } from "../components/notices";
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
