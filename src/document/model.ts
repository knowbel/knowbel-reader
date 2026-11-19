// The reflowable reader's interchange format. Format adapters produce this
// small, inert tree; annotations, selection, search, objects and navigation
// consume it without knowing whether the source was Markdown, HTML or EPUB.
// Source offsets are optional provenance, never rendered-text offsets.
export type DocumentFormat = "pdf" | "markdown" | "html" | "epub";
export type FlowTag = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "strong" | "em" | "del"
  | "a" | "code" | "pre" | "blockquote" | "ul" | "ol" | "li" | "table" | "thead" | "tbody"
  | "tr" | "th" | "td" | "hr" | "br" | "section" | "span" | "sup" | "sub" | "figure" | "figcaption" | "caption" | "dl" | "dt" | "dd";

export type FlowNode =
  | { type: "text"; value: string; start: number }
  | { type: "element"; tag: FlowTag; children: FlowNode[]; href?: string; id?: string; order?: number; checked?: boolean; colSpan?: number; rowSpan?: number; objectId?: string; start?: number; end?: number }
  | { type: "math"; value: string; display: boolean; start: number }
  | { type: "image"; src: string; alt: string; title?: string; start: number; objectId?: string }
  | { type: "media"; kind: "video" | "audio" | "embed"; src: string; value: string; poster?: string; start: number; objectId?: string };

export interface DocumentBlock {
  id: string;
  content: FlowNode;
  text: string;
  section: string;
  source?: { start: number; end: number };
}

export interface DocumentObject {
  id: string;
  kind: "image" | "table" | "video" | "audio" | "embed";
  blockId: string;
  label: string;
  start: number;
  end: number;
  src?: string;
}

export interface DocumentHeading {
  id: string;
  blockId: string;
  title: string;
  depth: number;
}

export interface FlowDocument {
  id: string;
  format: DocumentFormat;
  title: string;
  blocks: DocumentBlock[];
  outline: DocumentHeading[];
  objects: DocumentObject[];
  // An adapter may provide bundled images under internal, relative URLs.
  // They become scoped object URLs in the view, released on document close.
  assets?: Map<string, Blob>;
}

export interface TextPoint { blockId: string; offset: number }
export interface TextAnchor {
  kind: "text";
  start: TextPoint;
  end: TextPoint;
  quote: string;
  prefix: string;
  suffix: string;
}
export interface ObjectAnchor { kind: "object"; blockId: string; objectId: string }
export type FlowAnchor = TextAnchor | ObjectAnchor;
export interface FlowReference { id: string; anchor: FlowAnchor; targets: { anchor: FlowAnchor; label: string }[] }
export type DocumentAnchor = FlowAnchor | { kind: "pdf"; pageNumber: number; start: number; end: number };

export interface DocumentAnnotation {
  id: string;
  kind: "highlight" | "sticker";
  anchor: FlowAnchor;
  text: string;
  comment: string;
  color: string;
  style: "highlight" | "underline" | "strikethrough";
  paper?: string;
  createdAt: string;
}

// Fast deterministic content IDs, scoped to a content-addressed document.
// Duplicate blocks receive an occurrence suffix in prepareDocument.
export function contentKey(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

// Protocol policy shared by every adapter and by the view (defense in depth).
// Local file URLs and executable URLs never reach an element or the opener.
export function safeDocumentUrl(value: string, image = false): string | null {
  const url = value.trim();
  if (!url) return null;
  for (let i = 0; i < url.length; i++) if (url.charCodeAt(i) <= 32 || url.charCodeAt(i) === 127) return null;
  if (image && /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(url)) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    return (image ? /^https?:/i : /^(https?:|mailto:)/i).test(url) ? url : null;
  }
  if (/^(\/\/|\\)/.test(url)) return null;
  return url;
}
