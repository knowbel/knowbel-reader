// Plain Selection.toString() over KaTeX-rendered math is garbage: it
// concatenates the visually-hidden MathML copy, the raw TeX <annotation>,
// and the visible glyphs (each shattered into its own span, so often one
// per line) — and a selection that starts or ends mid-equation captures
// only fragments of each. Fed back into markdown (e.g. the dive's opening
// message), stray $ / \commands from that mess break remark-math and
// render as a red KaTeX error.
//
// This instead widens the range to cover any equation it touches, swaps
// each equation for its TeX source wrapped in $...$, and reads the rest as
// ordinary text — so the result round-trips through the same markdown +
// KaTeX pipeline the panel renders with.

import { compactText, nearestOccurrence } from "./annotate";

const KATEX_SELECTOR = ".katex-display, .katex";

function outermostKatex(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const inner = element?.closest(".katex");
  if (!inner) return null;
  return inner.closest(".katex-display") ?? inner;
}

function katexSource(katex: Element): string | null {
  const tex = katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
  return tex ? `$${tex}$` : null;
}

// innerText (unlike textContent) turns block boundaries into newlines the
// way the user sees them, but only on rendered elements — hence the
// briefly-attached offscreen host.
function renderedText(content: DocumentFragment | Element): string {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:600px;white-space:normal;";
  host.appendChild(content);
  document.body.appendChild(host);
  try {
    return host.innerText;
  } finally {
    host.remove();
  }
}

function replaceKatex(root: DocumentFragment | Element) {
  // A highlight's hover tooltip (its comment) renders inside the mark — it
  // isn't part of the text.
  for (const tooltip of Array.from(root.querySelectorAll(".dive-turn-highlight-tooltip"))) tooltip.remove();
  // querySelectorAll returns outer .katex-display before its inner .katex;
  // once the outer one is replaced the inner is detached, so skip it.
  for (const katex of Array.from(root.querySelectorAll(KATEX_SELECTOR))) {
    if (!root.contains(katex)) continue;
    const source = katexSource(katex);
    const isDisplay = katex.classList.contains("katex-display");
    const replacement = document.createElement(isDisplay ? "div" : "span");
    replacement.textContent = source ?? katex.querySelector(".katex-html")?.textContent ?? "";
    katex.replaceWith(replacement);
  }
}

function tidy(text: string): string {
  return text.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function widenOverKatex(range: Range): Range {
  const widened = range.cloneRange();
  const startKatex = outermostKatex(widened.startContainer);
  if (startKatex) widened.setStartBefore(startKatex);
  const endKatex = outermostKatex(widened.endContainer);
  if (endKatex) widened.setEndAfter(endKatex);
  return widened;
}

function serializeContents(range: Range): string {
  const fragment = range.cloneContents();
  replaceKatex(fragment);
  return tidy(renderedText(fragment));
}

export function serializeRange(range: Range): string {
  return serializeContents(widenOverKatex(range));
}

// Notebook captures preserve formatting as well as the stable matching text
// used by dive annotations. Serialize the selected fragment, not its entire
// answer, and widen partial equations before copying their TeX source.
export function serializeRichRange(range: Range): string {
  const fragment = widenOverKatex(range).cloneContents();
  for (const tooltip of fragment.querySelectorAll(".dive-turn-highlight-tooltip")) tooltip.remove();
  for (const math of fragment.querySelectorAll(KATEX_SELECTOR)) {
    if (!fragment.contains(math)) continue;
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) math.replaceWith(document.createTextNode(math.classList.contains("katex-display") ? `\n$$\n${tex}\n$$\n` : `$${tex}$`));
  }
  for (const chip of fragment.querySelectorAll(".cite-chip")) {
    const labels = chip.getAttribute("data-source-labels"), kind = chip.getAttribute("data-citation-kind");
    chip.replaceWith(document.createTextNode(kind === "general" ? " [general]" : labels ? ` [${kind === "inferred" ? "inferred: " : ""}${labels}]` : ""));
  }
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.replace(/\u00a0/g, " ") ?? "";
    const element = node as Element;
    const children = () => Array.from(node.childNodes).map(read).join("");
    switch (element.tagName?.toLowerCase()) {
      case "strong": case "b": return `**${children()}**`;
      case "em": case "i": return `*${children()}*`;
      case "s": case "del": return `~~${children()}~~`;
      case "pre": return `\n\n\`\`\`${element.querySelector("code")?.className.match(/language-([\w+-]+)/)?.[1] ?? ""}\n${element.textContent ?? ""}\n\`\`\`\n\n`;
      case "code": return `\`${children()}\``;
      case "br": return "\n";
      case "p": case "div": return `${children()}\n\n`;
      case "h1": case "h2": case "h3": case "h4": return `${"#".repeat(Number(element.tagName.slice(1)))} ${children()}\n\n`;
      case "li": return `- ${children().trim()}\n`;
      case "ul": case "ol": return `\n${children()}\n`;
      case "blockquote": return `${children().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      case "a": return element.getAttribute("href") && element.getAttribute("href") !== "#" ? `[${children()}](${element.getAttribute("href")})` : children();
      case "img": return `![${element.getAttribute("alt") ?? ""}](${element.getAttribute("src") ?? ""})`;
      case "table": {
        const rows = Array.from(element.querySelectorAll("tr")).map((row) => `| ${Array.from(row.children).map((cell) => read(cell).trim().replace(/\n/g, "<br>").replace(/\|/g, "\\|")).join(" | ")} |`);
        if (rows.length) rows.splice(1, 0, `| ${Array.from(element.querySelector("tr")?.children ?? []).map(() => "---").join(" | ")} |`);
        return `\n\n${rows.join("\n")}\n\n`;
      }
      default: return children();
    }
  };
  return read(fragment).trim();
}

// Which copy of `text` within `container` (one turn's rendered markdown)
// the reader selected — counted in the same whitespace-free, "$tex$"-for-
// equations form annotate.ts matches in, so a phrase appearing more than
// once in a turn is placed back on the copy that was actually selected.
export function selectionOccurrence(container: Element, range: Range, text: string): number {
  const before = document.createRange();
  before.setStart(container, 0);
  const widened = widenOverKatex(range);
  before.setEnd(widened.startContainer, widened.startOffset);
  const prefix = compactText(serializeContents(before));
  const full = compactText(serializeElement(container));
  return nearestOccurrence(full, compactText(text), prefix.length);
}

export function serializeElement(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  replaceKatex(clone);
  return tidy(renderedText(clone));
}
