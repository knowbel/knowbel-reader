import { safeDocumentUrl } from "../document/model.ts";
import { sniffImageType } from "../epub/paths.ts";
import type { PreparedArticle } from "./convert.ts";
import { mediaUrl, playerUrl } from "../document/media.ts";

function dataUrl(bytes: Uint8Array): string {
  const kind = sniffImageType(bytes);
  if (!["png", "jpeg", "gif", "webp"].includes(kind)) throw new Error("The saved article contains an unsupported image.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/${kind};base64,${btoa(binary)}`;
}

// One portable source file contains the article and its pictures. A saved
// timestamp lives in metadata, so an unchanged fetch has identical bytes.
export function articleSnapshot(article: PreparedArticle, sourceUrl: string): Uint8Array {
  const { meta, files } = article;
  const doc = article.content.ownerDocument;
  const make = (tag: string, value?: string) => {
    const element = doc.createElement(tag);
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const html = make("html");
  if (meta.lang) html.setAttribute("lang", meta.lang);
  const head = make("head");
  const charset = make("meta");
  charset.setAttribute("charset", "utf-8");
  head.append(charset, make("title", meta.title));
  const body = make("body");
  const header = make("header");
  if (meta.siteName) header.append(make("p", meta.siteName));
  const title = make("h1", meta.title);
  if (article.titleAnchor) title.id = article.titleAnchor;
  header.append(title);
  if (meta.dek) header.append(make("p", meta.dek));
  if (meta.authors.length) header.append(make("p", `By ${meta.authors.join(", ")}`));
  if (meta.publishedLabel || meta.publishedAt) header.append(make("p", `Published ${meta.publishedLabel || meta.publishedAt}`));
  const source = make("a", sourceUrl);
  source.setAttribute("href", sourceUrl);
  const line = make("p");
  line.append(source);
  header.append(line);
  const content = make("article");
  for (const node of article.content.childNodes) content.append(node.cloneNode(true));
  for (const node of content.querySelectorAll("script, style, link, object, embed, template, base")) node.remove();
  for (const frame of content.querySelectorAll("iframe")) {
    const src = playerUrl(frame.getAttribute("src") || "");
    if (src) frame.setAttribute("src", src); else frame.remove();
  }
  for (const media of content.querySelectorAll("video, audio")) {
    if (!mediaUrl(media.getAttribute("src") || "")) media.remove();
  }
  const images = new Map<string, string>();
  for (const image of content.querySelectorAll("img")) {
    const path = image.getAttribute("src") ?? "";
    const bytes = files.get(path);
    if (!bytes) throw new Error("An article image wasn't saved. Please try adding the page again.");
    if (!images.has(path)) images.set(path, dataUrl(bytes));
    image.setAttribute("src", images.get(path)!);
  }
  const attributes = new Set(["id", "name", "href", "src", "alt", "title", "start", "colspan", "rowspan", "poster", "data-kr-math"]);
  for (const node of content.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) if (!attributes.has(attr.name)) node.removeAttribute(attr.name);
    const href = node.getAttribute("href");
    if (href && !safeDocumentUrl(href)) node.removeAttribute("href");
  }
  body.append(header, content);
  html.append(head, body);
  return new TextEncoder().encode(`<!doctype html>${html.outerHTML}`);
}
