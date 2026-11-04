import test from "node:test";
import assert from "node:assert/strict";
import { markdownAdapter } from "./adapter.ts";
import { safeDocumentUrl, type FlowDocument, type FlowNode } from "../document/model.ts";
import { isMarkdown } from "../document/registry.ts";

export function markdown(source: string): FlowDocument {
  return markdownAdapter.parse({ id: "a".repeat(64), bytes: new TextEncoder().encode(source), fileName: "Study Notes.MD" }) as FlowDocument;
}

function nodes(document: FlowDocument): FlowNode[] {
  const all: FlowNode[] = [];
  const visit = (node: FlowNode) => { all.push(node); if (node.type === "element") node.children.forEach(visit); };
  document.blocks.forEach((block) => visit(block.content));
  return all;
}

test("Markdown builds semantic headings, formatted text, code, lists and a nested outline", () => {
  const document = markdown("# Study\n\nA **bold** and [linked](https://example.org) passage.\n\n## Methods\n\n- [x] Completed\n- [ ] Pending\n\n```ts\nconst x = 1;\n```\n\n## Methods\n\n> Quoted text\n");
  assert.equal(document.title, "Study");
  assert.deepEqual(document.outline.map(({ id, title, depth }) => ({ id, title, depth })), [
    { id: "study", title: "Study", depth: 1 }, { id: "methods", title: "Methods", depth: 2 }, { id: "methods-1", title: "Methods", depth: 2 },
  ]);
  assert.equal(document.blocks[1].text, "A bold and linked passage.\n");
  assert.equal(document.blocks[3].section, "Study › Methods");
  assert.ok(nodes(document).some((node) => node.type === "element" && node.tag === "li" && node.checked === false));
  assert.ok(document.blocks.some((block) => block.text.includes("[x] Completed\n[ ] Pending")));
  assert.ok(nodes(document).some((node) => node.type === "element" && node.tag === "pre"));
  assert.ok(document.blocks.every((block) => block.source && block.source.end > block.source.start));
});

test("Markdown identifies images and tables structurally and indexes their readable text", () => {
  const document = markdown("# Results\n\n![Training curve](figures/curve.png)\n\n| Epoch | Loss |\n| --- | --- |\n| 1 | 0.2 |\n\n![Other image](https://example.org/image.png)");
  assert.deepEqual(document.objects.map((object) => object.kind), ["image", "table", "image"]);
  assert.equal(document.objects[0].label, "Training curve");
  const table = document.blocks.find((block) => block.id === document.objects[1].blockId)!;
  assert.match(table.text, /Epoch\tLoss\t\n1\t0\.2/);
  assert.equal(document.objects[1].label, "Table 1");
});

test("canonical offsets count displayed text, with math represented exactly once as TeX", () => {
  const document = markdown("Use **bold**, [links](#next), and $E=mc^2$.\n\n$$\nx^2+y^2=z^2\n$$");
  assert.equal(document.blocks[0].text, "Use bold, links, and E=mc^2.\n");
  const math = nodes(document).filter((node) => node.type === "math");
  assert.equal(math.length, 2);
  assert.equal(math[0].start, 21);
  assert.equal(math[1].value, "x^2+y^2=z^2");
  assert.equal(document.blocks[1].text, "x^2+y^2=z^2");
});

test("a table inside a quote has its own exact canonical text range", () => {
  const document = markdown("> Introductory text.\n>\n> | Heading | Value |\n> | --- | --- |\n> | A | 1 |\n>\n> Closing text.");
  const table = document.objects.find((object) => object.kind === "table")!;
  const block = document.blocks.find((block) => block.id === table.blockId)!;
  const text = block.text.slice(table.start, table.end);
  assert.match(text, /^Heading\tValue/);
  assert.ok(!text.includes("Introductory") && !text.includes("Closing"));
});

test("HTML stays inert, unsafe URLs are removed, references resolve, and code is not executed", () => {
  const document = markdown('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![bad](data:text/html,test)\n\n[Reference][ref]\n\n[ref]: https://example.org/ref\n\n`<img onerror=alert(1)>`');
  const all = nodes(document);
  assert.ok(document.blocks[0].text.includes("<script>"));
  assert.ok(!all.some((node) => node.type === "element" && node.href?.startsWith("javascript:")));
  assert.ok(!all.some((node) => node.type === "image" && node.src.startsWith("data:text")));
  assert.ok(all.some((node) => node.type === "element" && node.href === "https://example.org/ref"));
  for (const value of ["javascript:alert(1)", "JaVa\nScript:alert(1)", "file:///etc/passwd", "//example.org/a", "\\evil", "data:text/html,a"]) assert.equal(safeDocumentUrl(value), null, value);
  assert.equal(safeDocumentUrl("data:image/png;base64,aGVsbG8=", true), "data:image/png;base64,aGVsbG8=");
  assert.equal(safeDocumentUrl("data:image/svg+xml;base64,aGVsbG8=", true), null);
});

test("file detection handles empty MIME types and Unicode sources and rejects damaged UTF-8", () => {
  assert.equal(isMarkdown({ name: "NOTES.Markdown", type: "" }), true);
  assert.equal(isMarkdown({ name: "notes", type: "text/markdown; charset=utf-8" }), true);
  assert.equal(isMarkdown({ name: "notes.txt", type: "text/plain" }), false);
  assert.equal(markdown("\uFEFF# Café\n\nα and 😀").title, "Café");
  assert.equal(markdown("").blocks.length, 0);
  assert.throws(() => markdownAdapter.parse({ id: "a", bytes: new Uint8Array([0xff, 0xfe]), fileName: "broken.md" }));
  assert.throws(() => markdown("binary\0data"), /binary/);
});
