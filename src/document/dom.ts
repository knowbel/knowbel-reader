import type { FlowDocument, TextAnchor, TextPoint } from "./model.ts";
import { textAnchor } from "./anchors.ts";

// Only explicitly mapped runs contribute to selection offsets. Math's
// MathML/visual duplicate text and annotation controls are never counted.
export function pointAt(root: HTMLElement, node: Node, offset: number, end: boolean): TextPoint | null {
  const element = node instanceof Element ? node : node.parentElement;
  const run = element?.closest<HTMLElement>("[data-reader-run]");
  if (run && root.contains(run)) {
    const block = run.closest<HTMLElement>("[data-reader-block]");
    if (!block) return null;
    const start = Number(run.dataset.readerStart);
    if (run.dataset.readerAtomic) return { blockId: block.dataset.readerBlock!, offset: start + (end ? Number(run.dataset.readerLength) : 0) };
    const range = document.createRange();
    range.selectNodeContents(run);
    range.setEnd(node, offset);
    return { blockId: block.dataset.readerBlock!, offset: start + range.toString().length };
  }
  // A browser Range endpoint may be a paragraph/list container between its
  // children rather than a text node (Select All and keyboard selections).
  const children = [...node.childNodes];
  const candidates = end ? children.slice(0, offset).reverse() : children.slice(offset);
  for (const child of candidates) {
    const found = pointAt(root, child, end ? child.childNodes.length || child.textContent?.length || 0 : 0, end);
    if (found) return found;
  }
  return null;
}

export function pointFromScreen(root: HTMLElement, x: number, y: number, end = false): TextPoint | null {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret && root.contains(caret.offsetNode)) return pointAt(root, caret.offsetNode, caret.offset, end);
  const range = document.caretRangeFromPoint?.(x, y);
  return range && root.contains(range.startContainer) ? pointAt(root, range.startContainer, range.startOffset, end) : null;
}

export function rangeAt(root: HTMLElement, point: TextPoint): Range | null {
  const block = root.querySelector<HTMLElement>(`[data-reader-block="${CSS.escape(point.blockId)}"]`);
  if (!block) return null;
  for (const run of block.querySelectorAll<HTMLElement>("[data-reader-run]")) {
    const start = Number(run.dataset.readerStart);
    const length = Number(run.dataset.readerLength);
    if (point.offset < start || point.offset > start + length) continue;
    const range = document.createRange();
    if (run.dataset.readerAtomic) { range.selectNodeContents(run); return range; }
    let offset = point.offset - start;
    const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (offset <= (node.textContent?.length ?? 0)) { range.setStart(node, offset); range.collapse(true); return range; }
      offset -= node.textContent?.length ?? 0;
    }
  }
  return null;
}

export function selectionAnchor(root: HTMLElement, model: FlowDocument, selection: Selection | null): TextAnchor | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = pointAt(root, range.startContainer, range.startOffset, false);
  const end = pointAt(root, range.endContainer, range.endOffset, true);
  if (!start || !end) return null;
  const anchor = textAnchor(model, start, end);
  return anchor.quote.trim() ? anchor : null;
}
