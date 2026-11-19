import katex from "katex";
import { notebookHTML } from "../notebook/htmlExport.ts";
import type { NotebookAsset, NotebookDocument } from "../notebook/model.ts";
import { anchorRanges } from "./anchors.ts";
import { safeDocumentUrl, type DocumentAnnotation, type FlowDocument, type FlowNode } from "./model.ts";
import { mediaUrl } from "./media.ts";

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export async function annotatedHTML(model: FlowDocument, annotations: DocumentAnnotation[], notebook: NotebookDocument, assets: NotebookAsset[]): Promise<string> {
  const images = new Map<string, string>();
  for (const [path, blob] of model.assets ?? []) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    images.set(path, `data:${blob.type};base64,${btoa(binary)}`);
  }
  const ranges = new Map<string, { start: number; end: number; annotation: DocumentAnnotation }[]>();
  const objectMarks = new Map<string, DocumentAnnotation>();
  for (const annotation of annotations) {
    if (annotation.kind !== "highlight") continue;
    if (annotation.anchor.kind === "object") objectMarks.set(`${annotation.anchor.blockId}/${annotation.anchor.objectId}`, annotation);
    for (const range of anchorRanges(model, annotation.anchor)) ranges.set(range.blockId, [...ranges.get(range.blockId) ?? [], { ...range, annotation }]);
  }
  const markStyle = (mark: DocumentAnnotation) => {
    const color = /^#[\da-f]{3,8}$/i.test(mark.color) ? mark.color : "#ffe08a";
    return mark.style === "highlight" ? `background:${color};color:inherit` : `background:transparent;color:inherit;text-decoration:${mark.style === "underline" ? "underline" : "line-through"};text-decoration-color:${color}`;
  };
  const objectMark = (node: FlowNode, blockId: string) => "objectId" in node ? objectMarks.get(`${blockId}/${node.objectId}`) : undefined;
  const render = (node: FlowNode, blockId: string): string => {
    if (node.type === "element") {
      const mark = objectMark(node, blockId);
      const attrs = `${node.id ? ` id="${escape(node.id)}"` : ""}${node.href && safeDocumentUrl(node.href) ? ` href="${escape(node.href)}"` : ""}${node.order !== undefined ? ` start="${node.order}"` : ""}${node.colSpan ? ` colspan="${node.colSpan}"` : ""}${node.rowSpan ? ` rowspan="${node.rowSpan}"` : ""}${mark ? ` style="${markStyle(mark)}"` : ""}`;
      const checked = node.checked !== undefined ? `<input type="checkbox" disabled${node.checked ? " checked" : ""}> ` : "";
      return `<${node.tag}${attrs}>${checked}${node.children.map((child) => render(child, blockId)).join("")}${["br", "hr"].includes(node.tag) ? "" : `</${node.tag}>`}`;
    }
    if (node.type === "image") {
      const src = images.get(node.src) ?? (/^https?:|^data:image\//i.test(node.src) ? safeDocumentUrl(node.src, true) : null);
      const mark = objectMark(node, blockId);
      return src ? `<img src="${escape(src)}" alt="${escape(node.alt)}"${mark ? ` style="outline:3px solid ${/^#[\da-f]{3,8}$/i.test(mark.color) ? mark.color : "#ffe08a"}"` : ""}>` : `<p>${escape(node.alt || "Image unavailable")}</p>`;
    }
    if (node.type === "math") {
      const html = katex.renderToString(node.value, { output: "mathml", displayMode: node.display, throwOnError: false, trust: false, strict: false, maxExpand: 1000, maxSize: 20 });
      const mark = (ranges.get(blockId) ?? []).find((range) => range.start < node.start + node.value.length && range.end > node.start)?.annotation;
      return mark ? `<mark style="${markStyle(mark)}">${html}</mark>` : html;
    }
    if (node.type === "media") return `<p>${mediaUrl(node.src) ? `<a href="${escape(node.src)}">${escape(node.value || "Open media")}</a>` : escape(node.value)}</p>`;
    const relevant = (ranges.get(blockId) ?? []).filter((range) => range.start < node.start + node.value.length && range.end > node.start);
    const cuts = [...new Set([0, node.value.length, ...relevant.flatMap((range) => [Math.max(0, range.start - node.start), Math.min(node.value.length, range.end - node.start)])])].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((start, index) => {
      const end = cuts[index + 1], content = escape(node.value.slice(start, end));
      const mark = relevant.find((range) => range.start <= node.start + start && range.end >= node.start + end)?.annotation;
      if (!mark) return content;
      return `<mark style="${markStyle(mark)}">${content}</mark>`;
    }).join("");
  };
  const notes = notebookHTML(notebook, assets, model.title);
  let notesBody = notes.match(/<main>([\s\S]*)<\/main>/)?.[1] ?? "";
  for (const [path, src] of images) notesBody = notesBody.replaceAll(`src="${escape(path)}"`, `src="${src}"`);
  const style = "body{max-width:850px;margin:40px auto;padding:0 24px;font:16px/1.7 system-ui;color:#222}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}blockquote{border-left:3px solid #ccc;padding-left:16px}h1,h2,h3{line-height:1.3}math[display=block]{margin:1em 0}small{color:#666}.notebook{border-top:2px solid #aaa;margin-top:3em}@media print{body{max-width:none;margin:0}pre,figure,tr{break-inside:avoid}a{color:inherit}}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(model.title)}</title><style>${style}</style></head><body>${model.blocks.map((block) => render(block.content, block.id)).join("\n")}<section class="notebook"><h1>Notebook</h1>${notesBody}</section></body></html>`;
}

export function downloadAnnotatedHTML(html: string, title: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a"); link.href = url; link.download = `${title.replace(/[\\/:*?"<>|]/g, "_")} — Annotated.html`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function printAnnotatedHTML(html: string) {
  document.querySelector(".knowbel-print-document")?.remove();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const host = document.createElement("div"); host.className = "knowbel-print-document";
  const shadow = host.attachShadow({ mode: "open" });
  for (const style of parsed.querySelectorAll("style")) { const copy = document.createElement("style"); copy.textContent = style.textContent?.replace(/\bbody\b/g, ".print-content") ?? ""; shadow.append(copy); }
  const body = document.createElement("div"); body.className = "print-content"; body.append(...[...parsed.body.childNodes].map((node) => document.importNode(node, true))); shadow.append(body);
  document.body.append(host);
  let timeout: ReturnType<typeof setTimeout>;
  await Promise.race([Promise.all([...shadow.querySelectorAll("img")].map((image) => image.decode().catch(() => {}))), new Promise((resolve) => { timeout = setTimeout(resolve, 10000); })]);
  clearTimeout(timeout!);
  window.addEventListener("afterprint", () => host.remove(), { once: true });
  try {
    if ("__TAURI_INTERNALS__" in window) { const { invoke } = await import("@tauri-apps/api/core"); await invoke("print_reader"); }
    else window.print();
  } catch (error) { host.remove(); throw error; }
  // WKWebView's print panel outlives the command. Keep a hidden, immutable
  // copy until the panel is done; opening another print replaces it.
  setTimeout(() => host.remove(), 120000);
}
