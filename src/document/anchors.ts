import type { FlowAnchor, FlowDocument, FlowNode, TextAnchor, TextPoint } from "./model.ts";

export interface BlockRange { blockId: string; start: number; end: number }

export type SourceExcerptPart = { kind: "text"; value: string } | { kind: "math"; value: string; display: boolean };

const maps = new WeakMap<FlowDocument, { blocks: Map<string, FlowDocument["blocks"][number]>; indices: Map<string, number>; objects: Map<string, FlowDocument["objects"][number]>; excerpts: WeakMap<FlowAnchor, SourceExcerptPart[]> }>();
function lookup(document: FlowDocument) {
  let cached = maps.get(document);
  if (!cached) {
    cached = { blocks: new Map(document.blocks.map((block) => [block.id, block])), indices: new Map(document.blocks.map((block, index) => [block.id, index])),
      objects: new Map(document.objects.map((object) => [`${object.blockId}/${object.id}`, object])), excerpts: new WeakMap() };
    maps.set(document, cached);
  }
  return cached;
}

export function blockIndices(document: FlowDocument) { return lookup(document).indices; }

export function fragmentAnchor(document: FlowDocument, fragment: string): TextAnchor | null {
  let id = fragment.replace(/^#/, "");
  try { id = decodeURIComponent(id); } catch { /* use the literal fragment */ }
  const find = (node: FlowNode): Extract<FlowNode, { type: "element" }> | undefined => {
    if (node.type !== "element") return;
    if (node.id === id) return node;
    for (const child of node.children) { const target = find(child); if (target) return target; }
  };
  for (const block of document.blocks) {
    const target = find(block.content);
    if (target) return textAnchor(document, { blockId: block.id, offset: target.start ?? 0 }, { blockId: block.id, offset: target.end ?? block.text.length });
  }
  return null;
}

export function anchorRanges(document: FlowDocument, anchor: FlowAnchor): BlockRange[] {
  if (anchor.kind === "object") {
    const object = lookup(document).objects.get(`${anchor.blockId}/${anchor.objectId}`);
    return object ? [{ blockId: object.blockId, start: object.start, end: object.end }] : [];
  }
  const first = lookup(document).indices.get(anchor.start.blockId) ?? -1;
  const last = lookup(document).indices.get(anchor.end.blockId) ?? -1;
  if (first < 0 || last < first) return [];
  return document.blocks.slice(first, last + 1).map((block, i, blocks) => ({
    blockId: block.id,
    start: i === 0 ? Math.max(0, Math.min(block.text.length, anchor.start.offset)) : 0,
    end: i === blocks.length - 1 ? Math.max(0, Math.min(block.text.length, anchor.end.offset)) : block.text.length,
  })).filter((range) => range.end > range.start);
}

export function anchorText(document: FlowDocument, anchor: FlowAnchor): string {
  return anchorRanges(document, anchor).map((range) =>
    lookup(document).blocks.get(range.blockId)!.text.slice(range.start, range.end),
  ).join("\n");
}

// Use the source's math nodes and their canonical offsets. Keep partially
// selected math as exact text, just like any other partial range.
export function anchorExcerpt(document: FlowDocument, anchor: FlowAnchor): SourceExcerptPart[] {
  const { blocks, excerpts } = lookup(document);
  const cached = excerpts.get(anchor);
  if (cached) return cached;
  const resolved = resolveAnchor(document, anchor);
  const parts: SourceExcerptPart[] = [];
  for (const range of resolved ? anchorRanges(document, resolved) : []) {
    const block = blocks.get(range.blockId)!;
    if (parts.length) parts.push({ kind: "text", value: "\n" });
    let cursor = range.start;
    const addTextThrough = (end: number) => {
      if (end > cursor) parts.push({ kind: "text", value: block.text.slice(cursor, end) });
      cursor = end;
    };
    const visit = (node: FlowNode) => {
      if (node.type === "element") node.children.forEach(visit);
      if (node.type !== "math" || !node.value || node.start < cursor || node.start + node.value.length > range.end) return;
      addTextThrough(node.start);
      parts.push({ kind: "math", value: node.value, display: node.display });
      cursor = node.start + node.value.length;
    };
    visit(block.content);
    addTextThrough(range.end);
  }
  excerpts.set(anchor, parts);
  return parts;
}

export function textAnchor(document: FlowDocument, start: TextPoint, end: TextPoint): TextAnchor {
  const anchor: TextAnchor = { kind: "text", start, end, quote: "", prefix: "", suffix: "" };
  anchor.quote = anchorText(document, anchor);
  anchor.prefix = lookup(document).blocks.get(start.blockId)?.text.slice(Math.max(0, start.offset - 48), start.offset) ?? "";
  anchor.suffix = lookup(document).blocks.get(end.blockId)?.text.slice(end.offset, end.offset + 48) ?? "";
  return anchor;
}

// Exact ranges are checked against their quote. When IDs/offsets no longer
// resolve, recover only an unambiguous, context-matched occurrence. Never
// silently attach a saved note to a different copy of the same phrase.
export function resolveAnchor(document: FlowDocument, anchor: FlowAnchor): FlowAnchor | null {
  if (anchor.kind === "object") return anchorRanges(document, anchor).length ? anchor :
    lookup(document).objects.has(`${anchor.blockId}/${anchor.objectId}`) ? anchor : null;
  if (!anchor.quote && anchor.start.blockId === anchor.end.blockId && anchor.start.offset === anchor.end.offset) {
    const block = lookup(document).blocks.get(anchor.start.blockId);
    return block && anchor.start.offset >= 0 && anchor.start.offset <= block.text.length ? anchor : null;
  }
  if (anchorText(document, anchor) === anchor.quote && anchor.quote) return anchor;
  if (!anchor.quote) return null;
  const candidates: TextAnchor[] = [];
  for (const block of document.blocks) {
    let from = 0;
    for (;;) {
      const at = block.text.indexOf(anchor.quote, from);
      if (at < 0) break;
      const end = at + anchor.quote.length;
      if ((!anchor.prefix || block.text.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix) &&
          (!anchor.suffix || block.text.slice(end, end + anchor.suffix.length) === anchor.suffix)) {
        candidates.push(textAnchor(document, { blockId: block.id, offset: at }, { blockId: block.id, offset: end }));
      }
      from = at + 1;
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function anchorLabel(document: FlowDocument, anchor: FlowAnchor): string {
  const id = anchor.kind === "text" ? anchor.start.blockId : anchor.blockId;
  const block = lookup(document).blocks.get(id);
  return block?.section || document.title;
}

// Anchor identity ignores saved quotation/context metadata. Used to reopen the
// same passage's existing conversation rather than creating duplicate dives.
export function sameAnchor(a: FlowAnchor, b: FlowAnchor): boolean {
  if (a.kind === "object") return b.kind === "object" && a.blockId === b.blockId && a.objectId === b.objectId;
  return b.kind === "text" && a.start.blockId === b.start.blockId && a.start.offset === b.start.offset &&
    a.end.blockId === b.end.blockId && a.end.offset === b.end.offset;
}
