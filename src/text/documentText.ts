import type { PDFDocumentProxy } from "pdfjs-dist";
import type { FlowAnchor } from "../document/model.ts";
import { buildTextIndex, type DocumentTextIndex } from "../glossary/textIndex";
import { buildBm25, type Bm25Index } from "../grounding/retrieval";
import { getStorage } from "../storage";
import { compactPages, expandPages, type CacheIdentity } from "./cache";
import { chunkDocument, type TextChunk } from "./chunks";
import { buildSections, type OutlineSource, type Section } from "./sections";

// One place to get a document's text in its derived forms — the searchable
// index, citable chunks, and section map — each built once per open
// document and shared by search, glossary, and the AI features.

// The library id of the document being read. Set by App when a document
// opens, before its viewer mounts, so the first getTextIndex call — which
// may come from any component — already knows where the cache lives.
let activeDocId: string | null = null;

// A text provider exposes ordered reading units to the existing retrieval
// algorithms. `pageNumber`/`numPages` in that legacy API are unit ordinals
// here, never visual pages or fabricated PDF geometry. Persisted native
// references always include a semantic anchor and a human section label.
export interface TextProvider {
  kind: "flow";
  numPages: number;
  getTextIndex(): Promise<DocumentTextIndex>;
  getSections(): Promise<Section[]>;
  anchorForRange(unit: number, start: number, end: number): FlowAnchor;
  labelForUnit(unit: number): string;
}
export type TextDocument = PDFDocumentProxy | TextProvider;
export function isTextProvider(document: TextDocument): document is TextProvider {
  return "kind" in document && document.kind === "flow";
}

export function setActiveDocument(docId: string | null) {
  activeDocId = docId;
}

const indexCache = new WeakMap<TextDocument, Promise<DocumentTextIndex>>();
const chunkCache = new WeakMap<TextDocument, Promise<TextChunk[]>>();
const sectionCache = new WeakMap<TextDocument, Promise<Section[]>>();
const bm25Cache = new WeakMap<TextDocument, Promise<Bm25Index>>();

async function loadPages(pdfDocument: PDFDocumentProxy, docId: string | null) {
  const identity: CacheIdentity = {
    fingerprint: pdfDocument.fingerprints?.[0] ?? "",
    numPages: pdfDocument.numPages,
  };
  const storage = getStorage();
  if (docId) {
    try {
      const pages = expandPages(await storage.getData(docId, "textIndex"), identity);
      if (pages) return pages;
    } catch {
      // Unreadable cache: extract again, and overwrite it below.
    }
  }
  const { extractPageTextItems } = await import("react-pdf-highlighter-plus");
  const pages = await extractPageTextItems(pdfDocument);
  if (docId) {
    storage.putData(docId, "textIndex", compactPages(pages, identity)).catch(() => {
      // Only a cache: the next open extracts again.
    });
  }
  return pages;
}

// Extracting every page's text takes a while on a long book, so App starts
// this as soon as a document opens (and the result is cached on disk for
// the next open); lookups then usually find it ready.
export function getTextIndex(pdfDocument: TextDocument): Promise<DocumentTextIndex> {
  if (isTextProvider(pdfDocument)) return pdfDocument.getTextIndex();
  let index = indexCache.get(pdfDocument);
  if (!index) {
    index = loadPages(pdfDocument, activeDocId).then(buildTextIndex);
    index.catch(() => indexCache.delete(pdfDocument));
    indexCache.set(pdfDocument, index);
  }
  return index;
}

export function getChunks(pdfDocument: TextDocument): Promise<TextChunk[]> {
  let chunks = chunkCache.get(pdfDocument);
  if (!chunks) {
    chunks = getTextIndex(pdfDocument).then(chunkDocument);
    chunks.catch(() => chunkCache.delete(pdfDocument));
    chunkCache.set(pdfDocument, chunks);
  }
  return chunks;
}

// The relevance index over the chunks, for choosing what the model sees.
export function getBm25(pdfDocument: TextDocument): Promise<Bm25Index> {
  let index = bm25Cache.get(pdfDocument);
  if (!index) {
    index = getChunks(pdfDocument).then(buildBm25);
    index.catch(() => bm25Cache.delete(pdfDocument));
    bm25Cache.set(pdfDocument, index);
  }
  return index;
}

export function getSections(pdfDocument: TextDocument): Promise<Section[]> {
  if (isTextProvider(pdfDocument)) return pdfDocument.getSections();
  let sections = sectionCache.get(pdfDocument);
  if (!sections) {
    sections = buildSections(pdfDocument as unknown as OutlineSource);
    sectionCache.set(pdfDocument, sections);
  }
  return sections;
}
