import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
import { dataUrl, fingerprint, isNotebook, richMarkdown, sourceLocations, type NotebookAsset, type NotebookDocument, type NotebookEntry } from "./model.ts";

export function entryMarkdown(entry: NotebookEntry, doc: NotebookDocument, assetPath: (id: string) => string = (id) => `assets/${id}`): string {
  const captures = new Map(doc.captures.map((capture) => [capture.id, capture]));
  const quoted = entry.captureIds.flatMap((id) => {
    const capture = captures.get(id); if (!capture) return [];
    const location = capture.locationLabel ?? (capture.position ? `p. ${capture.position}` : capture.conversationId ? "AI explanation" : "Saved excerpt");
    const quote = capture.snapshotRich ? richMarkdown(capture.snapshotRich, assetPath) : capture.text ? sourceLocations(capture.text, capture.sources ?? []).split("\n").map((line) => `> ${line}`).join("\n") : "";
    return [quote, capture.imageId ? `![Saved region](${assetPath(capture.imageId)})` : "", `*${location}${capture.context ? ` · ${capture.context}` : ""}*`].filter(Boolean).join("\n\n");
  });
  return [...quoted, richMarkdown(entry.body, assetPath)].filter(Boolean).join("\n\n");
}
export function notebookMarkdown(doc: NotebookDocument, title: string, assetPath?: (id: string) => string): string {
  const chunks = [`# ${title}`, ""];
  for (const section of doc.sections) {
    const entries = doc.entries.filter((entry) => !entry.deletedAt && (entry.sectionId ?? "document") === section.id);
    if (!entries.length) continue;
    chunks.push(`## ${section.title}`, "", ...entries.map((entry) => entryMarkdown(entry, doc, assetPath)), "");
  }
  const placed = new Set(doc.sections.map((section) => section.id));
  const rest = doc.entries.filter((entry) => !entry.deletedAt && entry.sectionId !== null && !placed.has(entry.sectionId));
  chunks.push(...rest.map((entry) => entryMarkdown(entry, doc, assetPath)));
  return chunks.join("\n\n").trim() + "\n";
}
function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function exportNotebook(doc: NotebookDocument, assets: NotebookAsset[], title: string, portable = false) {
  const base = title.replace(/[\\/:*?"<>|]/g, "_") || "Notebook";
  if (!portable && !assets.length) { download(new Blob([notebookMarkdown(doc, title)], { type: "text/markdown" }), `${base} — Notebook.md`); return; }
  download(new Blob([notebookBundle(doc, assets, title, portable) as Uint8Array<ArrayBuffer>], { type: "application/zip" }), `${base} — Notebook${portable ? '.knowbel' : ''}.zip`);
}
export function notebookBundle(doc: NotebookDocument, assets: NotebookAsset[], title: string, portable = true): Uint8Array {
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const metadata = assets.map((asset) => ({ id: asset.id, mediaType: asset.mediaType, path: `assets/${asset.id.replace(/[^a-z\d._-]/gi, '_')}-${fingerprint(asset.id)}.${extensions[asset.mediaType] ?? 'bin'}` }));
  const paths = new Map(metadata.map((asset) => [asset.id, asset.path]));
  const files: Record<string, Uint8Array> = { "notebook.md": strToU8(notebookMarkdown(doc, title, (id) => paths.get(id) ?? `assets/${id}`)) };
  if (portable) files["notebook.json"] = strToU8(JSON.stringify(doc));
  for (const asset of assets) files[paths.get(asset.id)!] = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0));
  if (portable) files["assets.json"] = strToU8(JSON.stringify(metadata));
  return zipSync(files);
}
export async function readNotebookBundle(file: File): Promise<{ document: NotebookDocument; assets: NotebookAsset[] }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const zip = unzipSync(bytes);
  const document = JSON.parse(strFromU8(zip["notebook.json"] ?? new Uint8Array()));
  if (!isNotebook(document)) throw new Error("This file isn't a supported Knowbel notebook.");
  const metadata = JSON.parse(strFromU8(zip["assets.json"] ?? strToU8("[]"))) as (Pick<NotebookAsset, "id" | "mediaType"> & { path?: string })[];
  const assets = metadata.map((asset) => {
    const bytes = zip[asset.path ?? `assets/${asset.id.replace(/[^a-z\d._-]/gi, '_')}`];
    if (!bytes) throw new Error("An image is missing from this notebook bundle.");
    // Avoid a large spread argument for high-resolution pasted images.
    let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { id: asset.id, mediaType: asset.mediaType, data: btoa(binary) };
  });
  for (const asset of assets) if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(dataUrl(asset))) throw new Error("This notebook includes an unsupported asset.");
  return { document, assets };
}
