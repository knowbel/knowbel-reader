import katex from "katex";
import { parseRichMarkdown } from "./codec.ts";
import { dataUrl, sourceLocations, type NotebookAsset, type NotebookDocument, type RichNode } from "./model.ts";

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const safeUrl = (url: string) => /^(https?:|mailto:|#|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(url) ? url : '';
export function notebookHTML(doc: NotebookDocument, assets: NotebookAsset[], title: string): string {
  const images = new Map(assets.map((asset) => [asset.id, dataUrl(asset)]));
  const render = (node: RichNode): string => {
    if (node.text !== undefined) {
      let text = escape(node.text);
      for (const mark of node.marks ?? []) {
        const tag = ({ bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code' } as Record<string, string>)[mark.type];
        if (tag) text = `<${tag}>${text}</${tag}>`;
        else if (mark.type === 'link') text = `<a href="${escape(safeUrl(mark.attrs?.href ?? ''))}">${text}</a>`;
      }
      return text;
    }
    const children = () => node.content?.map(render).join('') ?? '';
    switch (node.type) {
      case 'doc': return children();
      case 'contribution': return `<section>${children()}<small>AI-assisted${node.attrs?.origin?.context ? ` · ${escape(node.attrs.origin.context)}` : ''}</small></section>`;
      case 'paragraph': return `<p>${children()}</p>`;
      case 'heading': { const level = Math.max(1, Math.min(6, Number(node.attrs?.level) || 2)); return `<h${level}>${children()}</h${level}>`; }
      case 'hardBreak': return '<br>';
      case 'horizontalRule': return '<hr>';
      case 'bulletList': return `<ul>${children()}</ul>`;
      case 'orderedList': return `<ol>${children()}</ol>`;
      case 'listItem': return `<li>${children()}</li>`;
      case 'blockquote': return `<blockquote>${children()}</blockquote>`;
      case 'codeBlock': return `<pre><code>${children()}</code></pre>`;
      case 'table': return `<div class="table"><table><tbody>${children()}</tbody></table></div>`;
      case 'tableRow': return `<tr>${children()}</tr>`;
      case 'tableHeader': return `<th>${children()}</th>`;
      case 'tableCell': return `<td>${children()}</td>`;
      case 'image': { const src = node.attrs?.assetId ? images.get(node.attrs.assetId) ?? '' : safeUrl(node.attrs?.src ?? ''); return `<figure><img src="${escape(src)}" alt="${escape(node.attrs?.alt ?? '')}"></figure>`; }
      case 'inlineMath': case 'blockMath': {
        try { return katex.renderToString(node.attrs?.latex ?? '', { output: 'mathml', displayMode: node.type === 'blockMath', throwOnError: false, strict: false }); }
        catch { return `<code>${escape(node.attrs?.latex)}</code>`; }
      }
      case 'sourceCitation': return `<span class="citation">(${escape((node.attrs?.refs ?? []).map((ref: { source: { locationLabel?: string; pageNumber: number } }) => ref.source.locationLabel ?? `p. ${ref.source.pageNumber}`).join(', ') || node.attrs?.kind)})</span>`;
      case 'aiExchange': {
        const attrs = node.attrs ?? {};
        // Static export remains useful without Knowbel or an AI connection.
        const answer = attrs.editedBody ? render(attrs.editedBody) : render(parseRichMarkdown(attrs.answer || attrs.pendingAnswer || '', attrs.sources ?? []));
        const sources = (attrs.sources ?? []).map((source: { locationLabel?: string; pageNumber: number; text: string }) => `<blockquote><small>${escape(source.locationLabel ?? `p. ${source.pageNumber}`)}</small><p>${escape(source.text)}</p></blockquote>`).join('');
        return `<section class="ai"><p><strong>Question:</strong> ${escape(attrs.question)}</p>${answer}<small>AI-assisted${attrs.editedBody ? ' · edited' : ''}</small>${sources}</section>`;
      }
      default: return children();
    }
  };
  const captures = new Map(doc.captures.map((capture) => [capture.id, capture]));
  const sections = doc.sections.map((section) => {
    const entries = doc.entries.filter((entry) => !entry.deletedAt && (entry.sectionId ?? 'document') === section.id);
    if (!entries.length) return '';
    return `<section><h2>${escape(section.title)}</h2>${entries.map((entry) => {
      const sources = entry.captureIds.flatMap((id) => {
        const capture = captures.get(id); if (!capture) return [];
        const location = capture.locationLabel ?? (capture.position ? `p. ${capture.position}` : 'Saved excerpt');
        return `<blockquote><small>${escape(location)}${capture.context ? ` · ${escape(capture.context)}` : ''}</small>${capture.snapshotRich ? render(capture.snapshotRich) : `<p>${escape(sourceLocations(capture.text, capture.sources ?? []))}</p>`}${capture.imageId && images.has(capture.imageId) ? `<img src="${images.get(capture.imageId)}" alt="Saved source region">` : ''}</blockquote>`;
      }).join('');
      return `<article>${sources}${render(entry.body)}${entry.origin ? '<small>AI-assisted excerpt</small>' : ''}</article>`;
    }).join('')}</section>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — Notebook</title><style>body{max-width:800px;margin:40px auto;padding:0 24px;font:16px/1.65 system-ui,sans-serif;color:#292824}h1,h2,h3{line-height:1.3}article{margin:24px 0 36px}blockquote{margin:14px 0;padding:4px 16px;border-left:2px solid #ccc;color:#5b5952}small,.citation{color:#777;font-size:.8em}img{max-width:100%;height:auto}pre{padding:14px;background:#f5f4f0;overflow:auto}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ccc}.table{overflow:auto}.ai{padding:16px;border:1px solid #ddd;border-radius:8px}math[display=block]{margin:18px 0;overflow:auto}a{color:#345f9d}</style><main><h1>${escape(title)}</h1>${sections}</main></html>`;
}
export function exportNotebookHTML(doc: NotebookDocument, assets: NotebookAsset[], title: string) {
  const blob = new Blob([notebookHTML(doc, assets, title)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_')} — Notebook.html`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
