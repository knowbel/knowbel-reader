import type { FlowNode } from "../document/model.ts";
import type { RichNode } from "./model.ts";

export function flowSnapshot(node: FlowNode): RichNode {
  const convert = (node: FlowNode, marks: NonNullable<RichNode["marks"]> = []): RichNode[] => {
    if (node.type === "text") return node.value ? [{ type: "text", text: node.value, ...(marks.length ? { marks } : {}) }] : [];
    if (node.type === "math") return [{ type: node.display ? "blockMath" : "inlineMath", attrs: { latex: node.value } }];
    if (node.type === "image") return [{ type: "image", attrs: { src: node.src, alt: node.alt } }];
    const mark = ({ strong: "bold", em: "italic", del: "strike", code: "code", a: "link" } as Record<string, string>)[node.tag];
    if (mark) return node.children.flatMap((child) => convert(child, [...marks, { type: mark, ...(mark === 'link' ? { attrs: { href: node.href } } : {}) }]));
    const content = node.children.flatMap((child) => convert(child, marks));
    const type = ({ p: "paragraph", blockquote: "blockquote", pre: "codeBlock", ul: "bulletList", ol: "orderedList", li: "listItem", table: "table", tr: "tableRow", td: "tableCell", th: "tableHeader", br: "hardBreak", hr: "horizontalRule" } as Record<string, string>)[node.tag];
    if (/^h[1-6]$/.test(node.tag)) return [{ type: "heading", attrs: { level: Number(node.tag.slice(1)) }, content }];
    if (!type) return content;
    return [{ type, content: type === "tableCell" || type === "tableHeader" ? [{ type: "paragraph", content }] : content }];
  };
  return { type: "doc", content: convert(node) };
}
