import { contentKey, type DocumentBlock, type FlowDocument, type FlowNode } from "./model.ts";

// Assign canonical text offsets once, before any layout. Rendered text leaves
// carry these offsets; neither DOM textContent nor Markdown source positions
// are used to infer them later. Math is an atomic TeX run, images use alt text.
export function prepareDocument(input: Omit<FlowDocument, "outline" | "objects">): FlowDocument {
  const document: FlowDocument = { ...input, outline: [], objects: [] };
  const occurrences = new Map<string, number>();
  const slugs = new Map<string, number>();
  const path: { depth: number; title: string }[] = [];
  let tableCount = 0;
  for (const block of document.blocks) {
    let text = "";
    const visit = (node: FlowNode) => {
      if (node.type === "element") {
        const start = text.length;
        if (node.tag === "table" || node.checked !== undefined) node.start = start;
        if (node.checked !== undefined) text += node.checked ? "[x] " : "[ ] ";
        if (node.tag === "br") text += "\n";
        for (const child of node.children) visit(child);
        if (["p", "li", "tr", "pre", "blockquote", "figcaption", "caption", "dt", "dd"].includes(node.tag) && text && !text.endsWith("\n")) text += "\n";
        if (["td", "th"].includes(node.tag)) text += "\t";
        if (node.tag === "table") { node.objectId = `table-${contentKey(text.slice(start))}-${start}`; node.end = text.length; }
      } else {
        node.start = text.length;
        text += node.type === "image" ? node.alt : node.value;
        if (node.type === "image") node.objectId = `image-${contentKey(node.src + node.alt)}-${node.start}`;
      }
    };
    visit(block.content);
    block.text = text;
    const key = contentKey(JSON.stringify(block.content));
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    block.id = `b-${key}-${occurrence}`;
    const root = block.content;
    if (root.type === "element" && /^h[1-6]$/.test(root.tag)) {
      const depth = Number(root.tag[1]);
      const title = text.trim();
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
      const count = slugs.get(slug) ?? 0;
      slugs.set(slug, count + 1);
      root.id = count ? `${slug}-${count}` : slug;
      while (path.length && path[path.length - 1].depth >= depth) path.pop();
      path.push({ depth, title });
      document.outline.push({ id: root.id, blockId: block.id, title, depth });
    }
    block.section = path.map((entry) => entry.title).join(" › ") || document.title;
    const objects = (node: FlowNode) => {
      if (node.type === "image") {
        document.objects.push({ id: node.objectId!, kind: "image", blockId: block.id, label: node.alt || node.title || "Image",
          start: node.start, end: node.start + node.alt.length, src: node.src });
      } else if (node.type === "element") {
        if (node.tag === "table") {
          document.objects.push({ id: node.objectId!, kind: "table", blockId: block.id, label: `Table ${++tableCount}`,
            start: node.start!, end: node.end! });
        }
        node.children.forEach(objects);
      }
    };
    objects(root);
  }
  return document;
}

export function unpreparedBlock(content: FlowNode, source?: DocumentBlock["source"]): DocumentBlock {
  return { id: "", content, text: "", section: "", ...(source ? { source } : {}) };
}
