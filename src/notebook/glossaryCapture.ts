import type { GlossaryEntry } from "../glossary/types";
import type { NotebookCapture } from "./model";
import type { NotebookStore } from "./store";
import { saveNotebookExcerpt } from "./capture";

export function saveGlossaryDefinition(store: NotebookStore, entry: GlossaryEntry) {
  const ref = entry.refs.find((ref) => ref.id === entry.definedRefId) ?? entry.refs[0];
  const at = new Date().toISOString();
  const capture: Partial<NotebookCapture> = { position: ref?.pageNumber ?? entry.pageNumber, locationLabel: ref?.locationLabel, conversationId: `glossary:${entry.id}`, context: `Glossary · ${entry.term} · ${entry.source ?? 'document usage'}` };
  if (ref?.location) capture.native = { id: crypto.randomUUID(), kind: "highlight", anchor: ref.location, text: ref.match, comment: "", color: "#ffe08a", style: "highlight", createdAt: at };
  else if (ref?.position) capture.pdf = { id: crypto.randomUUID(), type: "text", content: { text: ref.match }, position: ref.position, createdAt: at };
  if (entry.image) capture.imageId = store.addImageDataUrl(`data:${entry.image.mediaType};base64,${entry.image.data}`);
  const reference = entry.reference ? `\n\nReference: [${entry.reference.site} · ${entry.reference.label}](${entry.reference.url})` : "";
  return saveNotebookExcerpt(store, `### ${entry.term}\n\n${entry.definition}${reference}`, capture);
}
