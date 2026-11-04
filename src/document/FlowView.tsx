import { createElement, lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DocumentAnnotation, DocumentBlock, FlowAnchor, FlowDocument, FlowNode, TextPoint } from "./model.ts";
import { safeDocumentUrl } from "./model.ts";
import { anchorRanges, resolveAnchor, textAnchor } from "./anchors.ts";
import { pointAt, rangeAt, selectionAnchor } from "./dom.ts";
import type { AnchorRect } from "../deepdive/useFlippedPlacement";
import { stickerStyle, STICKER_DEFAULT_PAPER } from "../stickerStyles";
import { openExternal } from "../library/desktop";
import { showNotice } from "../components/notices";

const MathRun = lazy(() => import("./MathRun"));
const EMPTY_MARKS: MarkRange[] = [];
interface MarkRange { start: number; end: number; annotation: DocumentAnnotation }
export interface FlowSelection { anchor: FlowAnchor; rect: AnchorRect; annotationId?: string }
export interface FlowGlossaryMark { entryId: string; anchor: FlowAnchor }

function FlowImage({ node, assets }: { node: Extract<FlowNode, { type: "image" }>; assets: Map<string, string> }) {
  const [failed, setFailed] = useState(false);
  const src = assets.get(node.src) ?? (/^https?:|^data:image\//i.test(node.src) ? safeDocumentUrl(node.src, true) : null);
  return <span className="flow-image" data-reader-object={node.objectId}>
    {src && !failed ? <img src={src} alt={node.alt} title={node.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> :
      <span className="flow-missing-image">{node.alt || "Image"}<small>{src ? "Image unavailable" : `Image file not included: ${node.src}`}</small></span>}
  </span>;
}

function renderNode(node: FlowNode, key: string, marks: MarkRange[], assets: Map<string, string>): ReactNode {
  if (node.type === "element") {
    const children = node.children.map((child, i) => renderNode(child, `${key}-${i}`, marks, assets));
    if (node.checked !== undefined) children.unshift(<span key="check" data-reader-run data-reader-atomic="true" data-reader-start={node.start} data-reader-length={4}>
      <input type="checkbox" disabled checked={node.checked} aria-label={node.checked ? "Completed" : "Incomplete"} /></span>);
    const objectMark = node.objectId && marks.find((mark) => mark.annotation.anchor.kind === "object" && mark.annotation.anchor.objectId === node.objectId);
    return createElement(node.tag, { key, id: node.id, href: node.href ? safeDocumentUrl(node.href) ?? undefined : undefined,
      "data-annotation-id": objectMark ? objectMark.annotation.id : undefined, className: objectMark ? "flow-object-mark" : undefined,
      start: node.tag === "ol" ? node.order : undefined, "data-reader-object": node.objectId }, ...children);
  }
  const value = node.type === "image" ? node.alt : node.value;
  const common = { "data-reader-run": true, "data-reader-start": node.start, "data-reader-length": value.length };
  if (node.type === "math" || node.type === "image") {
    const mark = marks.find((mark) => (mark.end > node.start && mark.start < node.start + value.length) ||
      (node.type === "image" && mark.annotation.anchor.kind === "object" && mark.annotation.anchor.objectId === node.objectId));
    const glossaryId = mark?.annotation.id.startsWith("glossary:") ? mark.annotation.id.slice(9) : undefined;
    return <span key={key} {...common} data-reader-atomic="true" data-annotation-id={glossaryId ? undefined : mark?.annotation.id} data-glossary-id={glossaryId} className={mark ? "flow-atomic-mark" : undefined}>
      {node.type === "math" ? <Suspense fallback={<code>{value}</code>}><MathRun value={value} display={node.display} /></Suspense> : <FlowImage node={node} assets={assets} />}
    </span>;
  }
  const relevant = marks.filter((mark) => mark.start < node.start + value.length && mark.end > node.start);
  if (!relevant.length) return <span key={key} {...common}>{value}</span>;
  const cuts = [...new Set([0, value.length, ...relevant.flatMap((mark) => [Math.max(0, mark.start - node.start), Math.min(value.length, mark.end - node.start)])])].sort((a, b) => a - b);
  return <span key={key} {...common}>{cuts.slice(0, -1).map((start, i) => {
    const end = cuts[i + 1];
    const mark = relevant.find((mark) => mark.start <= node.start + start && mark.end >= node.start + end);
    if (!mark) return value.slice(start, end);
    const { annotation } = mark;
    const glossaryId = annotation.id.startsWith("glossary:") ? annotation.id.slice(9) : undefined;
    return <mark key={start} data-annotation-id={glossaryId ? undefined : annotation.id} data-glossary-id={glossaryId}
      className={`flow-mark flow-mark--${annotation.style}${annotation.id === "flash" ? " flow-mark--flash" : ""}${glossaryId ? " flow-mark--glossary" : ""}`}
      style={{ "--mark-color": annotation.color } as CSSProperties}>{value.slice(start, end)}</mark>;
  })}</span>;
}

const FlowBlock = memo(function FlowBlock({ block, marks, assets }: { block: DocumentBlock; marks: MarkRange[]; assets: Map<string, string> }) {
  return <section className="flow-block" data-reader-block={block.id}>{renderNode(block.content, block.id, marks, assets)}</section>;
});

function FlowView({ model, annotations, glossaryMarks, onGlossary, flash, scale, notesCollapsed, noteMode, onSelection, onSticker, onPosition, navigate, onNavigate }: {
  model: FlowDocument;
  annotations: DocumentAnnotation[];
  glossaryMarks: FlowGlossaryMark[];
  onGlossary: (entryId: string, rect: AnchorRect) => void;
  flash: FlowAnchor | null;
  scale: number;
  notesCollapsed: boolean;
  noteMode: boolean;
  onSelection: (selection: FlowSelection) => void;
  onSticker: (anchor: FlowAnchor) => void;
  onPosition: (point: TextPoint) => void;
  navigate: { anchor: FlowAnchor; sequence: number } | null;
  onNavigate: (anchor: FlowAnchor) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const [assets, setAssets] = useState(new Map<string, string>());
  useEffect(() => {
    const urls = new Map<string, string>();
    for (const [path, blob] of model.assets ?? []) urls.set(path, URL.createObjectURL(blob));
    setAssets(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [model]);

  const marks = useMemo(() => {
    const grouped = new Map<string, MarkRange[]>();
    const all = [...(flash ? [{ id: "flash", kind: "highlight", anchor: flash, color: "#8fb0e8", style: "highlight" } as DocumentAnnotation] : []),
      ...annotations, ...glossaryMarks.map((mark) => ({ id: `glossary:${mark.entryId}`, kind: "highlight", anchor: mark.anchor,
        color: "var(--link)", style: "underline" } as DocumentAnnotation))];
    for (const annotation of all) {
      if (annotation.kind !== "highlight") continue;
      const resolved = resolveAnchor(model, annotation.anchor);
      if (!resolved) continue;
      for (const range of anchorRanges(model, resolved)) {
        const list = grouped.get(range.blockId) ?? [];
        list.push({ ...range, annotation });
        grouped.set(range.blockId, list);
      }
    }
    return grouped;
  }, [model, annotations, glossaryMarks, flash]);
  const stickers = useMemo(() => {
    const grouped = new Map<string, DocumentAnnotation[]>();
    for (const annotation of annotations) {
      if (annotation.kind !== "sticker") continue;
      const id = annotation.anchor.kind === "text" ? annotation.anchor.start.blockId : annotation.anchor.blockId;
      const list = grouped.get(id) ?? [];
      list.push(annotation); grouped.set(id, list);
    }
    return grouped;
  }, [annotations]);

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!navigate) return;
    const anchor = resolveAnchor(model, navigate.anchor);
    if (!anchor) { showNotice("This saved passage couldn't be located."); return; }
    const id = anchor.kind === "text" ? anchor.start.blockId : anchor.blockId;
    const frame = requestAnimationFrame(() => {
      const block = rootRef.current?.querySelector<HTMLElement>(`[data-reader-block="${CSS.escape(id)}"]`);
      block?.scrollIntoView({ block: "start", behavior: "instant" });
      const root = rootRef.current;
      if (root && anchor.kind === "text") {
        const range = rangeAt(root, anchor.start);
        if (range) root.scrollTop += range.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [model, navigate]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visible = new Map<Element, number>();
    // One observer for the document; no per-word listeners or geometry
    // polling. Offscreen content uses browser rendering containment.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target, entry.boundingClientRect.top);
        else visible.delete(entry.target);
      }
      const first = [...visible.keys()].sort((a, b) => {
        if (a === b) return 0;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })[0] as HTMLElement | undefined;
      if (first?.dataset.readerBlock) positionCallback.current({ blockId: first.dataset.readerBlock, offset: 0 });
    }, { root, rootMargin: "0px 0px -65% 0px" });
    root.querySelectorAll("[data-reader-block]").forEach((block) => observer.observe(block));
    return () => observer.disconnect();
  }, [model]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const recordPosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const article = root.querySelector<HTMLElement>(".flow-document");
        if (!article) return;
        const bounds = root.getBoundingClientRect();
        const x = Math.max(bounds.left + 4, article.getBoundingClientRect().left + parseFloat(getComputedStyle(article).paddingLeft) + 4);
        const caret = document.caretPositionFromPoint?.(x, bounds.top + 24);
        if (caret && root.contains(caret.offsetNode)) {
          const point = pointAt(root, caret.offsetNode, caret.offset, false);
          if (point) positionCallback.current(point);
        } else {
          const range = document.caretRangeFromPoint?.(x, bounds.top + 24);
          if (range && root.contains(range.startContainer)) {
            const point = pointAt(root, range.startContainer, range.startOffset, false);
            if (point) positionCallback.current(point);
          }
        }
      });
    };
    root.addEventListener("scroll", recordPosition, { passive: true });
    return () => { cancelAnimationFrame(frame); root.removeEventListener("scroll", recordPosition); };
  }, [model]);

  const capture = () => {
    const root = rootRef.current;
    if (!root) return;
    const current = window.getSelection();
    const anchor = selectionAnchor(root, model, current);
    if (!anchor) return;
    const rect = current!.getRangeAt(0).getBoundingClientRect();
    onSelection({ anchor, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } });
  };
  const stickerAt = (target: EventTarget) => {
    const block = (target as Element).closest<HTMLElement>("[data-reader-block]");
    const text = model.blocks.find((blockModel) => blockModel.id === block?.dataset.readerBlock);
    if (text) onSticker(textAnchor(model, { blockId: text.id, offset: 0 }, { blockId: text.id, offset: text.text.length }));
  };

  return <div ref={rootRef} className={`flow-scroll${noteMode ? " flow-note-mode" : ""}`} tabIndex={0} aria-label={model.title}
    onMouseOver={(event) => {
      const term = (event.target as Element).closest<HTMLElement>("[data-glossary-id]");
      if (!term || (event.relatedTarget instanceof Node && term.contains(event.relatedTarget))) return;
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => {
        if (window.getSelection()?.isCollapsed === false) return;
        const rect = term.getBoundingClientRect();
        onGlossary(term.dataset.glossaryId!, { left: rect.left, top: rect.top, bottom: rect.bottom });
      }, 220);
    }} onMouseOut={() => clearTimeout(hoverTimer.current)}
    onMouseUp={capture} onKeyUp={(event) => { if (event.key.startsWith("Arrow") || event.key === "Shift" || (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey))) capture(); }}
    onContextMenu={(event) => { if ((event.target as Element).closest("[data-reader-block]")) { event.preventDefault(); stickerAt(event.target); } }}
    onClick={(event) => {
      if (noteMode) { event.preventDefault(); stickerAt(event.target); return; }
      const target = event.target as Element;
      const term = target.closest<HTMLElement>("[data-glossary-id]");
      if (term && window.getSelection()?.isCollapsed !== false) { event.preventDefault(); const rect = term.getBoundingClientRect(); onGlossary(term.dataset.glossaryId!, { left: rect.left, top: rect.top, bottom: rect.bottom }); return; }
      const annotation = target.closest<HTMLElement>("[data-annotation-id]");
      const saved = annotation && annotations.find((entry) => entry.id === annotation.dataset.annotationId);
      if (saved && window.getSelection()?.isCollapsed !== false) {
        event.preventDefault();
        const rect = annotation!.getBoundingClientRect();
        onSelection({ anchor: saved.anchor, annotationId: saved.id, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } });
        return;
      }
      const objectEl = target.closest<HTMLElement>("[data-reader-object]");
      const object = objectEl && model.objects.find((object) => object.id === objectEl.dataset.readerObject && object.blockId === objectEl.closest<HTMLElement>("[data-reader-block]")?.dataset.readerBlock);
      if (object && window.getSelection()?.isCollapsed !== false) {
        event.preventDefault();
        const rect = objectEl!.getBoundingClientRect();
        onSelection({ anchor: { kind: "object", blockId: object.blockId, objectId: object.id }, rect: { left: rect.left, top: Math.max(rect.top, event.clientY), bottom: event.clientY + 10 } });
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href")!;
      if (href.startsWith("#")) {
        let slug = href.slice(1);
        try { slug = decodeURIComponent(slug); } catch { /* use literal fragment */ }
        const heading = model.outline.find((heading) => heading.id === slug);
        const block = model.blocks.find((block) => block.id === heading?.blockId);
        if (block) onNavigate(textAnchor(model, { blockId: block.id, offset: 0 }, { blockId: block.id, offset: block.text.length }));
      } else if (/^https?:|^mailto:/i.test(href) && safeDocumentUrl(href)) void openExternal(href);
      else showNotice("This link refers to a file outside the imported document.");
    }}>
    <article className="flow-document" style={{ fontSize: `${scale}%` }}>
      {model.blocks.length ? model.blocks.map((block) => <div className="flow-block-group" key={block.id}>
        <FlowBlock block={block} marks={marks.get(block.id) ?? EMPTY_MARKS} assets={assets} />
        <div className="flow-block-stickers">{(stickers.get(block.id) ?? []).map((annotation) =>
          <button type="button" key={annotation.id} className="flow-sticker" style={stickerStyle(annotation.paper ?? STICKER_DEFAULT_PAPER)} aria-label={`Sticky note: ${annotation.comment || "Empty note"}`}
            onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onSelection({ anchor: annotation.anchor, annotationId: annotation.id, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } }); }}>
            {notesCollapsed ? "Note" : annotation.comment || "Add a note…"}
          </button>)}</div>
      </div>) : <p className="sidebar-empty">This document is empty.</p>}
    </article>
  </div>;
}

export default memo(FlowView);
