import type { FlowAnchor, FlowDocument, TextAnchor, TextPoint } from "./model.ts";

export interface BlockRange { blockId: string; start: number; end: number }

const maps = new WeakMap<FlowDocument, { blocks: Map<string, FlowDocument["blocks"][number]>; indices: Map<string, number>; objects: Map<string, FlowDocument["objects"][number]> }>();
function lookup(document: FlowDocument) {
  let cached = maps.get(document);
  if (!cached) {
    cached = { blocks: new Map(document.blocks.map((block) => [block.id, block])), indices: new Map(document.blocks.map((block, index) => [block.id, index])),
      objects: new Map(document.objects.map((object) => [`${object.blockId}/${object.id}`, object])) };
    maps.set(document, cached);
  }
  return cached;
}

export function blockIndices(document: FlowDocument) { return lookup(document).indices; }

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
