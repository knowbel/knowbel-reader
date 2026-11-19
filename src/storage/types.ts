import type { DocumentFormat, TextPoint } from "../document/model.ts";

// Everything Knowbel Reader keeps per document, behind one small interface with
// two backends: plain files in the app data folder on desktop (desktop.ts)
// and IndexedDB on the web (indexedDb.ts). See
// docs/superpowers/specs/2026-09-27-grounded-study-roadmap.md §4.1.

// One stored value per kind, so saving highlights never rewrites the (much
// larger) dive history.
export type DocDataKind =
  | "notebook"
  | "notebookAssets"
  | "readerDrafts"
  | "highlights"
  | "dives"
  | "pins"
  | "diveHighlights"
  | "generalNotes"
  | "glossary"
  | "threads"
  | "nativeAnnotations"
  | "textIndex"
  | "thumbnail"; // the library card's cover: page 1, as a JPEG data URL

export const DOC_DATA_KINDS: readonly DocDataKind[] = [
  "notebook",
  "notebookAssets",
  "readerDrafts",
  "highlights",
  "dives",
  "pins",
  "diveHighlights",
  "generalNotes",
  "glossary",
  "threads",
  "nativeAnnotations",
  "textIndex",
  "thumbnail",
];

// How the document was last being read, restored when it's reopened.
export interface ReadingView {
  zoom: number | "auto";
  twoPage: boolean;
  continuous: boolean;
  panel: string | null; // the sidebar panel open, if any
  notebookOpen?: boolean;
  threadId?: string | null; // native reader's open study thread
  nativeDiveFocus?: string | null;
  pageMode?: boolean;
  pageScroll?: number;
}

export interface DocumentMeta {
  docId: string; // SHA-256 of original source bytes (PDF, EPUB or native text), hex
  title: string;
  fileName: string;
  byteLength: number;
  addedAt: string; // ISO timestamps
  openedAt: string;
  author?: string;
  pageCount?: number;
  lastPage?: number;
  view?: ReadingView;
  // Absent in existing libraries: the stored file is a PDF, including
  // EPUBs and web articles converted by earlier versions of the reader.
  format?: DocumentFormat;
  readingPosition?: TextPoint;
  readingProgress?: number;
  textScale?: number;
  // Notes imported (from a backup) for a PDF that isn't in this library yet:
  // importing that PDF brings them together.
  fileMissing?: boolean;
  // Where a document added from the web came from (src/web/).
  source?: DocumentSource;
}

export interface DocumentSource {
  kind: "web";
  // "article": a web page, saved as native HTML (PDF in older libraries);
  // "pdf" / "epub": a file the address led straight to.
  format: "article" | "pdf" | "epub";
  url: string; // as the reader gave it
  finalUrl: string; // after redirects
  canonicalUrl: string; // what's compared to tell if it's already in the library
  siteName?: string;
  publishedAt?: string; // as the page states it (ISO when it can be read as a date)
  fetchedAt: string; // ISO
  // When the original page was last saved for offline replay (desktop).
  pageArchivedAt?: string;
}

export interface LibraryStorage {
  listDocuments(): Promise<DocumentMeta[]>;
  getMeta(docId: string): Promise<DocumentMeta | null>;
  putMeta(meta: DocumentMeta): Promise<void>;
  getFile(docId: string): Promise<Uint8Array | null>;
  putFile(docId: string, bytes: Uint8Array, format?: DocumentFormat): Promise<void>;
  getData<T>(docId: string, kind: DocDataKind): Promise<T | null>;
  putData(docId: string, kind: DocDataKind, value: unknown): Promise<void>;
  removeDocument(docId: string): Promise<void>;
  // The original web page as a WebKit archive (desktop only). It can be
  // replaced by a newer capture and isn't part of notes backups.
  getPageArchive?(docId: string): Promise<Uint8Array | null>;
  putPageArchive?(docId: string, bytes: Uint8Array): Promise<void>;
}
