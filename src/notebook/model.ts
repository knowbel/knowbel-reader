import type { CommentedHighlight } from "../types.ts";
import type { DocumentAnnotation } from "../document/model.ts";
import type { DiveHighlight, DivePanel, GeneralNote, Pin } from "../deepdive/types.ts";
import type { SourceRef } from "../grounding/types.ts";

// This schema belongs to Knowbel. Editor-specific nodes are confined to body;
// source identities, annotation geometry, assets, and provenance survive export.
export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: RichNode[];
}
export interface NotebookSection { id: string; title: string; position?: number; custom?: boolean }
export interface NotebookEntry {
  id: string;
  sectionId: string | null;
  position?: number;
  body: RichNode;
  captureIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  origin?: { kind: "ai"; context?: string; conversationId?: string; turnId?: string; sources: SourceRef[] };
}
export interface NotebookCapture {
  id: string;
  kind: "pdf" | "native" | "dive" | "excerpt";
  text: string;
  snapshotRich?: RichNode;
  position?: number;
  locationLabel?: string;
  context?: string;
  sources?: SourceRef[];
  conversationId?: string;
  turnId?: string;
  imageId?: string;
  visible: boolean;
  pdf?: CommentedHighlight;
  native?: DocumentAnnotation;
  dive?: DiveHighlight;
}
export interface NotebookAsset { id: string; data: string; mediaType: string }
export interface NotebookDocument {
  schemaVersion: 1;
  docId: string;
  revision: number;
  migrated: true;
  sections: NotebookSection[];
  entries: NotebookEntry[];
  captures: NotebookCapture[];
  // Malformed legacy records are retained, never silently discarded.
  unparsed?: Record<string, unknown[]>;
}
export interface NotebookLegacy {
  highlights?: unknown;
  nativeAnnotations?: unknown;
  diveHighlights?: unknown;
  generalNotes?: unknown;
  pins?: unknown;
  dives?: unknown;
}
export const emptyBody = (): RichNode => ({ type: "doc", content: [{ type: "paragraph" }] });
export function textBody(text: string): RichNode {
  return { type: "doc", content: text.split(/\n\n/).map((part) => ({ type: "paragraph", content: part ? part.split("\n").flatMap((line, i) => [
    ...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : []),
  ]) : undefined })) };
}
export function richText(node: RichNode): string {
  if (node.type === "aiExchange") return `${node.attrs?.question ?? ""}\n${node.attrs?.editedBody ? richText(node.attrs.editedBody) : node.attrs?.answer || node.attrs?.pendingAnswer || ""}`;
  if (node.type === "inlineMath" || node.type === "blockMath") return node.attrs?.latex ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image") return node.attrs?.alt ?? "";
  if (node.text !== undefined) return node.text;
  const separator = ["doc", "blockquote", "bulletList", "orderedList", "listItem", "table", "tableRow"].includes(node.type) ? "\n" : "";
  return (node.content ?? []).map(richText).join(separator);
}
export function richMarkdown(node: RichNode, assetPath: (id: string) => string = (id) => `assets/${id}`): string {
  if (node.text !== undefined) {
    let text = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") text = `**${text}**`;
      else if (mark.type === "italic") text = `*${text}*`;
      else if (mark.type === "strike") text = `~~${text}~~`;
      else if (mark.type === "code") text = `\`${text}\``;
      else if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
    }
    return text;
  }
  const children = () => (node.content ?? []).map((child) => richMarkdown(child, assetPath)).join("");
  switch (node.type) {
    case "doc": return children().trim();
    case "paragraph": return `${children()}\n\n`;
    case "hardBreak": return "\n";
    case "heading": return `${"#".repeat(node.attrs?.level ?? 2)} ${children()}\n\n`;
    case "codeBlock": return `\n\`\`\`${node.attrs?.language ?? ""}\n${children()}\n\`\`\`\n\n`;
    case "blockquote": return children().trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    case "bulletList": case "orderedList": return (node.content ?? []).map((child, i) => `${node.type === "orderedList" ? `${i + (node.attrs?.start ?? 1)}.` : "-"} ${richMarkdown(child, assetPath).trim().replace(/\n/g, "\n  ")}`).join("\n") + "\n\n";
    case "listItem": return children();
    case "inlineMath": return `$${node.attrs?.latex ?? ""}$`;
    case "blockMath": return `\n$$\n${node.attrs?.latex ?? ""}\n$$\n\n`;
    case "image": return `![${node.attrs?.alt ?? ""}](${node.attrs?.assetId ? assetPath(node.attrs.assetId) : node.attrs?.src ?? ""})\n\n`;
    case "horizontalRule": return "---\n\n";
    case "table": {
      const rows = (node.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => richMarkdown(cell, assetPath).trim().replace(/\n/g, "<br>").replace(/\|/g, "\\|")).join(" | ")} |`);
      if (rows.length) rows.splice(1, 0, `| ${(node.content?.[0].content ?? []).map(() => "---").join(" | ")} |`);
      return rows.join("\n") + "\n\n";
    }
    case "aiExchange": {
      const attrs = node.attrs ?? {};
      const sources = (attrs.sources ?? []) as SourceRef[];
      const answer = attrs.editedBody ? richMarkdown(attrs.editedBody, assetPath) : sourceLocations(attrs.answer ?? attrs.pendingAnswer ?? "", sources);
      return `> **Question:** ${attrs.question ?? ""}\n\n${answer}\n\n${sources.map((source) => `> Source ${source.locationLabel ?? `p. ${source.pageNumber}`}: ${source.text}`).join("\n\n")}\n\n`;
    }
    case "contribution": return `${children()}\n*AI-assisted${node.attrs?.origin?.context ? ` · ${node.attrs.origin.context}` : ""}*\n\n`;
    case "sourceCitation": return ` (${(node.attrs?.refs ?? []).map((ref: { source: SourceRef }) => ref.source.locationLabel ?? `p. ${ref.source.pageNumber}`).join(", ") || node.attrs?.kind || "source"})`;
    default: return children();
  }
}
export function sourceLocations(text: string, sources: SourceRef[]): string {
  const byLabel = new Map(sources.map((source) => [source.label.toUpperCase(), source]));
  return text.replace(/\[\s*(inferred\s*:\s*)?(S\d+(?:\s*,\s*S\d+)*)\s*\]/gi, (_marker, inferred: string | undefined, labels: string) => {
    const locations = labels.split(',').flatMap((label) => { const source = byLabel.get(label.trim().toUpperCase()); return source ? [source.locationLabel ?? `p. ${source.pageNumber}`] : []; });
    return locations.length ? `(${inferred ? 'inferred from ' : ''}${[...new Set(locations)].join(', ')})` : '(source unavailable)';
  });
}
export function findRichNode(body: RichNode, id: string): RichNode | undefined {
  if (body.attrs?.id === id) return body;
  for (const child of body.content ?? []) { const found = findRichNode(child, id); if (found) return found; }
}
export function patchRichNode(body: RichNode, id: string, attrs: Record<string, unknown>): RichNode {
  if (body.attrs?.id === id) return { ...body, attrs: { ...body.attrs, ...attrs } };
  if (!body.content) return body;
  const content = body.content.map((child) => patchRichNode(child, id, attrs));
  return content.some((child, i) => child !== body.content![i]) ? { ...body, content } : body;
}
export function removeRichNode(body: RichNode, id: string): RichNode {
  if (!body.content) return body;
  const content = body.content.filter((child) => child.attrs?.id !== id).map((child) => removeRichNode(child, id));
  if (content.length === body.content.length && content.every((child, i) => child === body.content![i])) return body;
  // Exchanges are blocks; their document, quote, or table cell still needs a block.
  return { ...body, content: content.length ? content : [{ type: "paragraph" }] };
}
export function interruptExchanges(body: RichNode): RichNode {
  if (body.type === "aiExchange" && ["preparing", "streaming"].includes(body.attrs?.status)) return { ...body, attrs: { ...body.attrs, status: "interrupted" } };
  if (!body.content) return body;
  const content = body.content.map(interruptExchanges);
  return content.some((child, i) => child !== body.content![i]) ? { ...body, content } : body;
}
export function isNotebook(value: unknown): value is NotebookDocument {
  const doc = value as NotebookDocument | null;
  return !!doc && doc.schemaVersion === 1 && typeof doc.docId === "string" && Array.isArray(doc.entries) && Array.isArray(doc.captures) && Array.isArray(doc.sections);
}
export function newNotebook(docId: string): NotebookDocument {
  return { schemaVersion: 1, docId, revision: 0, migrated: true, sections: [{ id: "document", title: "Document notes" }], entries: [], captures: [] };
}
export function captureEntryId(id: string): string { return `entry:${id}`; }
export function assetFromDataUrl(id: string, data: string): NotebookAsset | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\s]+)$/i.exec(data);
  return match ? { id, mediaType: match[1], data: match[2].replace(/\s/g, "") } : undefined;
}
export function dataUrl(asset: NotebookAsset): string { return `data:${asset.mediaType};base64,${asset.data}`; }

export function migrateNotebook(docId: string, legacy: NotebookLegacy): { notebook: NotebookDocument; assets: NotebookAsset[] } {
  const notebook = newNotebook(docId);
  const assets: NotebookAsset[] = [];
  const panels = new Map((Array.isArray(legacy.dives) ? legacy.dives as DivePanel[] : []).map((panel) => [panel.id, panel]));
  const at = new Date().toISOString();
  const add = (capture: NotebookCapture, body: string, createdAt?: string) => {
    notebook.captures.push(capture);
    notebook.entries.push({ id: captureEntryId(capture.id), sectionId: null, position: capture.position, body: textBody(body), captureIds: [capture.id], createdAt: createdAt ?? at, updatedAt: createdAt ?? at });
  };
  for (const [kind, value] of Object.entries(legacy)) {
    if (!Array.isArray(value) || kind === "dives") continue;
    for (const item of value) {
      if (!item || typeof item.id !== "string") { (notebook.unparsed ??= {})[kind] ??= []; notebook.unparsed[kind].push(item); continue; }
      const retain = () => { (notebook.unparsed ??= {})[kind] ??= []; notebook.unparsed[kind].push(item); };
      if (kind === "highlights" && (!item.position?.boundingRect || !Number.isFinite(item.position.boundingRect.pageNumber) || !item.content)) { retain(); continue; }
      if (kind === "nativeAnnotations" && (!item.anchor || !["text", "object"].includes(item.anchor.kind))) { retain(); continue; }
      if (kind === "diveHighlights" && (typeof item.panelId !== "string" || typeof item.text !== "string")) { retain(); continue; }
      if ((kind === "generalNotes" || kind === "pins") && typeof item.text !== "string") { retain(); continue; }
      if (kind === "highlights") {
        const h = item as CommentedHighlight;
        const id = `pdf:${h.id}`;
        const { comment: _comment, ...pdf } = h;
        let imageId: string | undefined;
        if (h.content?.image) { const asset = assetFromDataUrl(`${id}:image`, h.content.image); if (asset) { assets.push(asset); imageId = asset.id; pdf.content = { ...pdf.content, image: undefined }; } }
        add({ id, kind: "pdf", text: h.type === "freetext" ? "" : h.content?.text ?? "", position: h.position?.boundingRect?.pageNumber, imageId, pdf, conversationId: h.divePanelId, visible: true }, h.type === "freetext" ? h.content?.text ?? "" : h.comment ?? "", h.createdAt);
      } else if (kind === "nativeAnnotations") {
        const h = item as DocumentAnnotation;
        const { comment: _comment, ...native } = h;
        add({ id: `native:${h.id}`, kind: "native", text: h.kind === "sticker" ? "" : h.text ?? "", native: { ...native, comment: "" }, visible: true }, h.comment ?? "", h.createdAt);
      } else if (kind === "diveHighlights") {
        const h = item as DiveHighlight;
        const { comment: _comment, ...dive } = h;
        const panel = panels.get(h.panelId);
        add({ id: `dive:${h.id}`, kind: "dive", text: h.text, dive, visible: true, position: panel?.pageNumber, context: panel?.label, sources: panel?.turns[h.turnIndex ?? 0]?.sources, conversationId: h.panelId }, h.comment ?? "", h.createdAt);
      } else if (kind === "pins") {
        const pin = item as Pin;
        add({ id: `pin:${pin.id}`, kind: "excerpt", text: pin.text, context: pin.context, visible: false }, pin.comment ?? "", pin.createdAt);
      } else if (kind === "generalNotes") {
        const note = item as GeneralNote;
        notebook.entries.push({ id: `note:${note.id}`, sectionId: "document", body: textBody(note.text), captureIds: [], createdAt: note.createdAt ?? at, updatedAt: note.createdAt ?? at });
      }
    }
  }
  return { notebook, assets };
}

export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function mergeNotebooks(stored: NotebookDocument, incoming: NotebookDocument): NotebookDocument {
  if (stored.docId !== incoming.docId) throw new Error("The notebook belongs to another document.");
  const sections = new Map(stored.sections.map((section) => [section.id, section]));
  for (const section of incoming.sections) if (!sections.has(section.id)) sections.set(section.id, section);
  const captures = new Map(stored.captures.map((capture) => [capture.id, capture]));
  const remap = new Map<string, string>();
  for (const capture of incoming.captures) {
    const current = captures.get(capture.id);
    if (!current) captures.set(capture.id, capture);
    else if (fingerprint(current) !== fingerprint(capture)) {
      // Different mark visibility/style isn't different source evidence.
      const evidence = (item: NotebookCapture) => JSON.stringify([item.text, item.kind, item.imageId, item.pdf?.position, item.native?.anchor, item.dive && [item.dive.panelId, item.dive.turnIndex, item.dive.text, item.dive.occurrence]]);
      if (evidence(current) === evidence(capture)) continue;
      const id = `${capture.id}:import:${fingerprint(capture)}`;
      captures.set(id, { ...capture, id }); remap.set(capture.id, id);
    }
  }
  const entries = new Map(stored.entries.map((entry) => [entry.id, entry]));
  for (const source of incoming.entries) {
    const entry = { ...source, captureIds: source.captureIds.map((id) => remap.get(id) ?? id) };
    const current = entries.get(entry.id);
    if (!current) entries.set(entry.id, entry);
    else if (current.deletedAt || entry.deletedAt) {
      if (entry.deletedAt && entry.deletedAt >= current.updatedAt && (!current.deletedAt || entry.deletedAt > current.deletedAt)) entries.set(entry.id, entry);
      else if (current.deletedAt && !entry.deletedAt && entry.updatedAt > current.deletedAt) entries.set(entry.id, entry);
    } else if (JSON.stringify(current.body) !== JSON.stringify(entry.body) || JSON.stringify(current.captureIds) !== JSON.stringify(entry.captureIds)) {
      const id = `${entry.id}:import:${fingerprint({ body: entry.body, captureIds: entry.captureIds })}`;
      if (!entries.has(id)) entries.set(id, { ...entry, id });
    }
  }
  const unparsed: Record<string, unknown[]> = { ...stored.unparsed };
  for (const [kind, records] of Object.entries(incoming.unparsed ?? {})) {
    const merged = new Map([...(unparsed[kind] ?? []), ...records].map((record) => [JSON.stringify(record), record])); unparsed[kind] = [...merged.values()];
  }
  return { ...stored, ...(Object.keys(unparsed).length ? { unparsed } : {}), revision: Math.max(stored.revision, incoming.revision) + 1, sections: [...sections.values()], captures: [...captures.values()], entries: [...entries.values()] };
}

export function aiContribution(body: RichNode, origin: NonNullable<NotebookEntry["origin"]>): RichNode {
  const content = body.content?.length ? body.content : [{ type: "paragraph" }];
  return { type: "contribution", attrs: { origin, originalHash: fingerprint(content) }, content };
}
export function hasRichContent(body: RichNode): boolean {
  return !!richText(body).trim() || ["image", "aiExchange", "table", "inlineMath", "blockMath", "horizontalRule"].includes(body.type) || !!body.content?.some(hasRichContent);
}

// Imported images can share IDs with a different revision of an existing
// notebook. Keep both and rewrite only the incoming document's asset references.
export function mergeNotebookAssets(stored: NotebookAsset[], incoming: NotebookAsset[], document: NotebookDocument): { assets: NotebookAsset[]; document: NotebookDocument } {
  const assets = new Map(stored.map((asset) => [asset.id, asset]));
  const remap = new Map<string, string>();
  for (const asset of incoming) {
    const current = assets.get(asset.id);
    if (current && (current.data !== asset.data || current.mediaType !== asset.mediaType)) {
      const id = `${asset.id}:import:${fingerprint({ data: asset.data, mediaType: asset.mediaType })}`;
      remap.set(asset.id, id); assets.set(id, { ...asset, id });
    } else if (!current) assets.set(asset.id, asset);
  }
  const rewrite = (value: any, key = ""): any => {
    if (typeof value === "string") {
      if (key === "assetId" || key === "imageId") return remap.get(value) ?? value;
      if (key === "src" && value.startsWith("asset:")) return `asset:${remap.get(value.slice(6)) ?? value.slice(6)}`;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => rewrite(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child, key)]));
    return value;
  };
  return { assets: [...assets.values()], document: remap.size ? rewrite(document) : document };
}

export function newExchange(question = ""): RichNode { return { type: "aiExchange", attrs: { id: crypto.randomUUID(), question, answer: "", sources: [], status: "idle", scope: "note" } }; }

export function entryContext(body: RichNode, excludeId: string): string {
  const parts: string[] = [];
  const walk = (node: RichNode) => {
    if (node.attrs?.id === excludeId) return;
    if (node.type === "aiExchange" || node.type === "contribution") { parts.push(`Earlier AI-assisted content (context, not evidence):\n${richText(node)}`); return; }
    if (["doc", "blockquote", "bulletList", "orderedList", "listItem"].includes(node.type)) { node.content?.forEach(walk); return; }
    const text = richText(node); if (text.trim()) parts.push(`Reader writing (context, not evidence):\n${text}`);
  };
  walk(body); return parts.join("\n\n").slice(0, 5000);
}
