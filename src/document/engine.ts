import type { DocumentTextIndex } from "../glossary/textIndex.ts";
import type { TextProvider } from "../text/documentText.ts";
import type { Section } from "../text/sections.ts";
import type { FlowAnchor, FlowDocument } from "./model.ts";
import { anchorRanges, blockIndices, textAnchor } from "./anchors.ts";

// One engine per open document. Text and heading indices are derived once,
// independently of viewport size and React renders. BM25/chunks are built
// lazily by documentText's shared WeakMap caches, only when a study tool asks.
export class DocumentEngine implements TextProvider {
  readonly kind = "flow" as const;
  readonly numPages: number;
  readonly blockIndex: Map<string, number>;
  private textIndex?: Promise<DocumentTextIndex>;
  private sections?: Promise<Section[]>;
  readonly document: FlowDocument;

  constructor(document: FlowDocument) {
    this.document = document;
    this.numPages = document.blocks.length;
    this.blockIndex = blockIndices(document);
  }

  getTextIndex(): Promise<DocumentTextIndex> {
    return this.textIndex ??= Promise.resolve({ pages: this.document.blocks.map((block, index) => ({
      canonical: true, pageNumber: index + 1, text: block.text, lower: block.text.toLowerCase(),
      width: 0, height: 0, items: [], charItem: [], charOffset: [],
    })) });
  }

  getSections() {
    return this.sections ??= Promise.resolve(this.document.outline.map((heading) => ({
      title: heading.title, depth: heading.depth - 1, pageNumber: (this.blockIndex.get(heading.blockId) ?? 0) + 1,
    })));
  }

  anchorForRange(unit: number, start: number, end: number) {
    const block = this.document.blocks[unit - 1];
    if (!block) throw new Error("This passage is no longer in the document.");
    return textAnchor(this.document, { blockId: block.id, offset: start }, { blockId: block.id, offset: end });
  }

  labelForUnit(unit: number) { return this.document.blocks[unit - 1]?.section || this.document.title; }

  unitForAnchor(anchor: FlowAnchor) {
    return (this.blockIndex.get(anchor.kind === "text" ? anchor.start.blockId : anchor.blockId) ?? 0) + 1;
  }

  ranges(anchor: FlowAnchor) { return anchorRanges(this.document, anchor); }

  // Search is over canonical text and returns native anchors directly.
  // Capped results keep broad queries from mounting thousands of rows.
  search(query: string, limit = 200) {
    const needle = query.toLowerCase().trim();
    const matches: { anchor: FlowAnchor; before: string; match: string; after: string }[] = [];
    if (!needle) return matches;
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    for (const [unit, block] of this.document.blocks.entries()) {
      // Unicode case folding can change length (e.g. İ). Match against the
      // original string with a regex so saved offsets remain UTF-16 offsets.
      for (const match of block.text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        matches.push({ anchor: this.anchorForRange(unit + 1, start, end), before: block.text.slice(Math.max(0, start - 55), start),
          match: match[0], after: block.text.slice(end, end + 70) });
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }
}
