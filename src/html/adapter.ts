import { parseDocument as parseHtml, DomUtils } from "htmlparser2";
import { contentKey, safeDocumentUrl, type FlowNode, type FlowTag } from "../document/model.ts";
import { playerUrl, mediaUrl } from "../document/media.ts";
import { inertSvg } from "./svg.ts";
import { prepareDocument, unpreparedBlock } from "../document/prepare.ts";
import type { DocumentAdapter } from "../document/registry.ts";
import { decodeHtml, parseSrcset, pickSrcsetCandidate } from "../web/html.ts";

type HtmlNode = ReturnType<typeof parseHtml>["children"][number];
type HtmlElement = Extract<HtmlNode, { attribs: Record<string, string> }>;
const isElement = (node: HtmlNode): node is HtmlElement => "attribs" in node;
const text = (value: string): FlowNode => ({ type: "text", value, start: 0 });
const element = (tag: FlowTag, children: FlowNode[], id?: string): FlowNode => ({ type: "element", tag, children, ...(id ? { id } : {}) });
const allowed = new Set<string>(["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "a", "code", "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "section", "sup", "sub", "figure", "figcaption", "caption", "dl", "dt", "dd"]);
const aliases: Record<string, FlowTag> = { b: "strong", i: "em", s: "del", strike: "del", tt: "code", div: "section", article: "section", main: "section", header: "section", footer: "section", nav: "section", aside: "section", address: "p", summary: "p" };
const containers = new Set(["html", "body", "div", "article", "main", "section", "header", "footer", "nav", "aside", "details", "center", "form"]);
const blocks = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "ul", "ol", "table", "hr", "figure", "dl"]);
const discarded = new Set(["head", "title", "base", "meta", "link", "script", "style", "noscript", "template", "object", "embed", "input", "button", "select", "textarea", "canvas"]);

function hidden(node: HtmlElement) {
  return "hidden" in node.attribs || node.attribs["aria-hidden"]?.toLowerCase() === "true" ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(node.attribs.style ?? "");
}

// Match HTML's ordinary whitespace across inline element boundaries. Code
// inside <pre> keeps its exact line breaks, tabs and indentation.
function normalize(root: FlowNode) {
  let atStart = true;
  let last: Extract<FlowNode, { type: "text" }> | undefined;
  const boundary = () => { if (last) last.value = last.value.replace(/ $/, ""); last = undefined; atStart = true; };
  const visit = (node: FlowNode) => {
    if (node.type === "text") {
      node.value = node.value.replace(/[\t\n\r\f ]+/g, " ");
      if (atStart) node.value = node.value.replace(/^ /, "");
      if (node.value) { atStart = node.value.endsWith(" "); last = node; }
    } else if (node.type === "element") {
      if (node.tag === "pre") { boundary(); return; }
      const block = blocks.has(node.tag) || ["section", "li", "tr", "td", "th", "dt", "dd", "figcaption", "caption", "br"].includes(node.tag);
      if (block) boundary();
      node.children.forEach(visit);
      if (block) boundary();
    } else { atStart = false; last = undefined; }
  };
  visit(root);
  boundary();
}

export const htmlAdapter: DocumentAdapter = {
  format: "html",
  parse({ id, bytes, fileName }) {
    const source = decodeHtml(bytes);
    if (source.includes("\0")) throw new Error("This file contains binary data, not HTML text.");
    // A pure parser: no live DOM, resource requests, stylesheet evaluation or
    // script execution, including while parsing in a module worker.
    const tree = parseHtml(source);
    const assets = new Map<string, Blob>();
    const find = (name: string) => DomUtils.findOne((node) => node.name === name, tree.children);
    const baseValue = find("base")?.attribs.href;
    const base = baseValue && /^https?:/i.test(baseValue) && safeDocumentUrl(baseValue) ? baseValue : undefined;
    const resolve = (value: string, image = false): string | null => {
      const safe = safeDocumentUrl(value, image);
      if (!safe || safe.startsWith("#") || !base) return safe;
      try { return safeDocumentUrl(new URL(safe, base).href, image); } catch { return null; }
    };
    const convert = (node: HtmlNode): FlowNode[] => {
      if (node.type === "text") return [text(node.data)];
      if (!isElement(node) || hidden(node)) return [];
      const tag = node.name;
      const attrs = node.attribs;
      const target = attrs.id || (tag === "a" ? attrs.name : undefined);
      if (tag === "svg") {
        const svg = inertSvg(DomUtils.getOuterHTML(node));
        if (!svg) return [];
        const src = `native-svg/${contentKey(svg)}.svg`;
        assets.set(src, new Blob([svg], { type: "image/svg+xml" }));
        const image: FlowNode = { type: "image", src, alt: attrs["aria-label"] || DomUtils.textContent(parseHtml(svg)).trim() || "Figure", start: 0 };
        return target ? [element("span", [image], target)] : [image];
      }
      if (tag === "video" || tag === "audio" || tag === "iframe") {
        const candidate = attrs.src || node.children.find((child) => isElement(child) && child.name === "source" && child.attribs.src);
        const raw = typeof candidate === "string" ? candidate : candidate && isElement(candidate) ? candidate.attribs.src : "";
        const resolved = resolve(raw || "");
        const src = tag === "iframe" ? playerUrl(resolved || "") : resolved && mediaUrl(resolved);
        const label = attrs.title || attrs["aria-label"] || (tag === "audio" ? "Audio" : "Video");
        if (!src) return resolved && mediaUrl(resolved) ? [element("p", [{ type: "element", tag: "a", href: resolved, children: [text(`Open ${label} on the original site`)] }])] : [text(label)];
        const media: FlowNode = { type: "media", kind: tag === "iframe" ? "embed" : tag, src, value: label, start: 0, ...(attrs.poster && resolve(attrs.poster, true) ? { poster: resolve(attrs.poster, true)! } : {}) };
        return target ? [element("span", [media], target)] : [media];
      }
      if (attrs["data-kr-math"] === "display" || attrs["data-kr-math"] === "inline") {
        const display = attrs["data-kr-math"] === "display";
        const delimiter = display ? "$$" : "$";
        const raw = DomUtils.textContent(node).trim();
        const value = raw.startsWith(delimiter) && raw.endsWith(delimiter) && raw.length >= delimiter.length * 2
          ? raw.slice(delimiter.length, -delimiter.length) : raw;
        const formula: FlowNode = { type: "math", value, display, start: 0 };
        return target ? [element("span", [formula], target)] : [formula];
      }
      // MathML and pre-rendered KaTeX expose the original TeX in an
      // annotation. Keep it once instead of duplicating visual/a11y text.
      if (tag === "math" || /(?:^|\s)katex(?:\s|$)/.test(attrs.class ?? "")) {
        const annotation = DomUtils.findOne((child) => child.name === "annotation" && /(?:tex|latex)/i.test(child.attribs.encoding ?? ""), node.children);
        if (annotation) {
          const parentClass = node.parent && "attribs" in node.parent ? node.parent.attribs.class ?? "" : "";
          const formula: FlowNode = { type: "math", value: DomUtils.textContent(annotation), display: attrs.display === "block" || /katex-display/.test(parentClass), start: 0 };
          return target ? [element("span", [formula], target)] : [formula];
        }
      }
      if (discarded.has(tag)) return [];
      const children = () => node.children.filter((child) =>
        !["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl"].includes(tag) || child.type !== "text" || child.data.trim(),
      ).flatMap(convert);
      if (tag === "img") {
        const candidate = attrs.src || attrs["data-src"] || pickSrcsetCandidate(parseSrcset(attrs.srcset ?? ""))?.url || "";
        const src = resolve(candidate, true);
        const image: FlowNode = src ? { type: "image", src, alt: attrs.alt ?? "", title: attrs.title, start: 0 } : text(attrs.alt ?? "");
        return target ? [element("span", [image], target)] : [image];
      }
      const content = children();
      let mapped = allowed.has(tag) ? tag as FlowTag : Object.hasOwn(aliases, tag) ? aliases[tag] : undefined;
      if (!mapped) return target ? [element("span", content, target)] : content;
      if (tag === "table" && content.some((child) => child.type === "element" && child.tag === "tr")) {
        // The browser parser normally inserts tbody; this inert parser
        // intentionally has no browser DOM to do that for us.
        let rows: FlowNode[] = [];
        const grouped: FlowNode[] = [];
        const flushRows = () => { if (rows.length) { grouped.push(element("tbody", rows)); rows = []; } };
        for (const child of content) {
          if (child.type === "element" && child.tag === "tr") rows.push(child);
          else if (child.type !== "text" || child.value.trim()) { flushRows(); grouped.push(child); }
        }
        flushRows();
        content.splice(0, content.length, ...grouped);
      }
      if (tag === "div" && !content.some((child) => child.type === "element" && (blocks.has(child.tag) || child.tag === "section"))) mapped = "p";
      const result = element(mapped, content, target) as Extract<FlowNode, { type: "element" }>;
      if (tag === "a") {
        result.href = resolve(attrs.href ?? "") ?? undefined;
        if (!result.href) result.tag = "span";
      }
      if (tag === "ol" && /^-?\d+$/.test(attrs.start ?? "")) result.order = Number(attrs.start);
      if (tag === "td" || tag === "th") {
        for (const [attr, field] of [["colspan", "colSpan"], ["rowspan", "rowSpan"]] as const) {
          const value = Number(attrs[attr]);
          if (Number.isInteger(value) && value > 1 && value <= 100) result[field] = value;
        }
      }
      if (tag === "li") {
        const checkbox = node.children.find((child) => isElement(child) && child.name === "input" && child.attribs.type?.toLowerCase() === "checkbox");
        if (checkbox && isElement(checkbox)) result.checked = Object.hasOwn(checkbox.attribs, "checked");
      }
      return [result];
    };
    const content: FlowNode[] = [];
    let inline: FlowNode[] = [];
    const flush = () => { if (inline.length) { content.push(element("p", inline)); inline = []; } };
    const collect = (nodes: HtmlNode[]) => {
      for (const node of nodes) {
        if (isElement(node) && (hidden(node) || discarded.has(node.name))) continue;
        if (isElement(node) && containers.has(node.name)) {
          flush();
          // Keep wrapper targets without grouping an entire article into a
          // single block (headings and large-document rendering need blocks).
          if (node.attribs.id) content.push(element("section", [], node.attribs.id));
          collect(node.children);
          flush();
        } else if (isElement(node) && blocks.has(node.name)) {
          flush(); content.push(...convert(node));
        } else inline.push(...convert(node));
      }
    };
    collect(tree.children);
    flush();
    for (const node of content) normalize(node);
    const nonempty = content.filter((node) => node.type !== "element" || node.id || node.tag === "hr" || node.children.some((child) => child.type !== "text" || child.value));
    const title = find("title");
    const document = prepareDocument({ id, format: "html", title: (title && DomUtils.textContent(title).replace(/\s+/g, " ").trim()) || fileName.replace(/\.(html?|xhtml)$/i, ""), blocks: nonempty.map((node) => unpreparedBlock(node)), ...(assets.size ? { assets } : {}) });
    if (!title || !DomUtils.textContent(title).trim()) document.title = document.outline.find((heading) => heading.depth === 1)?.title || document.title;
    return document;
  },
};
