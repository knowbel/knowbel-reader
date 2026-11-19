import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root, RootContent, PhrasingContent, Definition } from "mdast";
import { safeDocumentUrl, type FlowNode, type FlowTag } from "../document/model.ts";
import { prepareDocument, unpreparedBlock } from "../document/prepare.ts";
import type { DocumentAdapter } from "../document/registry.ts";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const element = (tag: FlowTag, children: FlowNode[]): FlowNode => ({ type: "element", tag, children });
const text = (value: string): FlowNode => ({ type: "text", value, start: 0 });

export const markdownAdapter: DocumentAdapter = {
  format: "markdown",
  parse({ id, bytes, fileName }) {
    // Fail on binary/invalid UTF-8 rather than importing a damaged document.
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    if (source.includes("\0")) throw new Error("This file contains binary data, not Markdown text.");
    const tree = parser.parse(source) as Root;
    const definitions = new Map<string, Definition>();
    const collect = (node: Root | RootContent) => {
      if (node.type === "definition") definitions.set(node.identifier.toLowerCase(), node);
      if ("children" in node) for (const child of node.children) collect(child as RootContent);
    };
    collect(tree);
    const convert = (node: RootContent | PhrasingContent): FlowNode[] => {
      const children = () => "children" in node ? node.children.flatMap((child) => convert(child as RootContent)) : [];
      switch (node.type) {
        case "text": return [text(node.value)];
        case "paragraph": return [element("p", children())];
        case "heading": return [element(`h${node.depth}` as FlowTag, children())];
        case "emphasis": return [element("em", children())];
        case "strong": return [element("strong", children())];
        case "delete": return [element("del", children())];
        case "inlineCode": return [element("code", [text(node.value)])];
        case "code": return [element("pre", [element("code", [text(node.value)])])];
        case "blockquote": return [element("blockquote", children())];
        case "list": return [{ type: "element", tag: node.ordered ? "ol" : "ul", children: children(), order: node.start ?? undefined }];
        case "listItem": return [{ type: "element", tag: "li", children: children().flatMap((child) =>
          !node.spread && child.type === "element" && child.tag === "p" ? child.children : [child]), checked: node.checked ?? undefined }];
        case "break": return [element("br", [])];
        case "thematicBreak": return [element("hr", [])];
        case "link": {
          const href = safeDocumentUrl(node.url);
          return href ? [{ type: "element", tag: "a", href, children: children() }] : children();
        }
        case "linkReference": {
          const definition = definitions.get(node.identifier.toLowerCase());
          const href = definition && safeDocumentUrl(definition.url);
          return href ? [{ type: "element", tag: "a", href, children: children() }] : children();
        }
        case "image": case "imageReference": {
          const definition = node.type === "imageReference" ? definitions.get(node.identifier.toLowerCase()) : node;
          const src = definition && safeDocumentUrl(definition.url, true);
          return src ? [{ type: "image", src, alt: node.alt ?? "", title: definition?.title ?? undefined, start: 0 }] : [text(node.alt ?? "")];
        }
        case "table": return [element("table", node.children.map((row, index) =>
          element(index === 0 ? "thead" : "tbody", [element("tr", row.children.map((cell) =>
            element(index === 0 ? "th" : "td", cell.children.flatMap(convert)),
          ))]),
        ))];
        case "inlineMath": case "math": return [{ type: "math", value: node.value, display: node.type === "math", start: 0 }];
        // Raw HTML stays inert. HTML files have their own parser and
        // explicit sanitization; it cannot bypass this reader's node schema.
        case "html": return [text(node.value)];
        case "definition": return [];
        case "footnoteReference": return [element("sup", [text(`[${node.identifier}]`)])];
        case "footnoteDefinition": return [element("section", [text(`[${node.identifier}] `), ...children()])];
        default: return children();
      }
    };
    const blocks = tree.children.flatMap((node) => convert(node).map((content) => unpreparedBlock(content,
      node.position ? { start: node.position.start.offset ?? 0, end: node.position.end.offset ?? 0 } : undefined,
    )));
    const document = prepareDocument({ id, format: "markdown", title: fileName.replace(/\.(md|markdown)$/i, ""), blocks });
    document.title = document.outline.find((heading) => heading.depth === 1)?.title || document.title;
    return document;
  },
};
