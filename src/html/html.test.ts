import test from "node:test";
import assert from "node:assert/strict";
import { htmlAdapter } from "./adapter.ts";
import type { FlowDocument, FlowNode } from "../document/model.ts";
import { fragmentAnchor, resolveAnchor, textAnchor } from "../document/anchors.ts";
import { DocumentEngine } from "../document/engine.ts";
import { DOCUMENT_FILE_ACCEPT, nativeDocumentFormat, parseDocument, releaseDocument } from "../document/registry.ts";
import { importFiles } from "../library/importFiles.ts";
import { exportNotes, importNotes } from "../library/library.ts";
import { createMemoryStorage } from "../storage/memory.ts";

function html(source: string) {
  return htmlAdapter.parse({ id: "a".repeat(64), bytes: new TextEncoder().encode(source), fileName: "Study.HTML" }) as FlowDocument;
}
function nodes(document: FlowDocument) {
  const all: FlowNode[] = [];
  const visit = (node: FlowNode) => { all.push(node); if (node.type === "element") node.children.forEach(visit); };
  document.blocks.forEach((block) => visit(block.content));
  return all;
}

test("HTML files and fragments preserve semantic content and flatten containers into reading blocks", () => {
  const document = html(`<!doctype html><html><head><title>Study &amp; notes</title></head><body><main><h1 id="intro">Introduction</h1>
    <div><p> A <b>bold</b> and <i>emphasized</i> passage. </p><section><h2>Methods</h2>
    <ol start="3"><li>First</li><li><s>Second</s></li></ol></section></div>
    <blockquote><p>Quoted text</p></blockquote><pre><code>  x &lt; 2\n\ty++;</code></pre></main></body></html>`);
  assert.equal(document.format, "html");
  assert.equal(document.title, "Study & notes");
  assert.equal(document.blocks.length, 6);
  assert.deepEqual(document.outline.map(({ id, title }) => [id, title]), [["intro", "Introduction"], ["methods", "Methods"]]);
  assert.equal(document.blocks[1].text, "A bold and emphasized passage.\n");
  assert.equal(document.blocks[3].section, "Introduction › Methods");
  assert.equal(document.blocks[5].text, "  x < 2\n\ty++;\n");
  assert.ok(nodes(document).some((node) => node.type === "element" && node.tag === "ol" && node.order === 3));
  assert.equal(html("<h1>Fragment</h1><p>Text</p>").title, "Fragment");
  assert.equal(html("").title, "Study");
});

test("HTML produces only inert nodes, removing executable URLs, controls and hidden content", () => {
  const document = html(`<head><style>body{display:none}</style><script>alert(1)</script></head><body onload="alert(1)">
    <script src="https://evil.invalid/run.js">secret</script><iframe srcdoc="bad">secret</iframe><object>secret</object>
    <template>secret</template><p hidden>secret</p><p aria-hidden="true">secret</p><p style="display: none !important">secret</p>
    <p onclick="bad()" style="background:url(https://evil.invalid)">Visible
    <a href="java&#x73;cript:alert(1)">link</a><a href="file:///etc/passwd">local</a><a href="//evil.invalid">network</a>
    <img src="data:image/svg+xml,bad" onerror="bad()" alt="fallback"><input value="secret"></p>
    <svg><script>bad()</script></svg><form><label>Label</label><button>secret</button></form><constructor>Custom element</constructor></body>`);
  const serialized = JSON.stringify(document);
  for (const forbidden of ["secret", "alert(1)", "onclick", "onload", "onerror", "javascript:", "file:///", "evil.invalid", "image/svg"]) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.ok(document.blocks.some((block) => block.text.includes("Visible linklocalnetwork fallback")));
  assert.ok(serialized.includes("fallback"));
  assert.ok(serialized.includes("Label"));
  assert.ok(serialized.includes("Custom element"));
  assert.ok(nodes(document).every((node) => node.type !== "element" || typeof node.tag === "string"));
});

test("HTML tables, images and formulas supply searchable text and exact canonical offsets", () => {
  const document = html(`<h1>Results</h1><figure><img src="https://example.org/plot.png" alt="Curve"><figcaption>A result</figcaption></figure>
    <table><caption>Scores</caption><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>0.2</td></tr></table>
    <p>Before <span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math><span aria-hidden="true">duplicate</span></span> after 😀.</p>`);
  assert.deepEqual(document.objects.map((object) => object.kind), ["image", "table"]);
  const table = document.objects[1];
  const block = document.blocks.find((block) => block.id === table.blockId)!;
  assert.match(block.text.slice(table.start, table.end), /Scores\nName\tValue\t\nA\t0.2\t\n/);
  const math = nodes(document).filter((node) => node.type === "math");
  assert.equal(math.length, 1);
  assert.equal(math[0].start, 7);
  const passage = document.blocks.at(-1)!;
  assert.equal(passage.text, "Before x^2 after 😀.\n");
  const after = nodes(document).find((node) => node.type === "text" && node.value.includes("after"))!;
  assert.equal(after.start, 10);
  const anchor = textAnchor(document, { blockId: passage.id, offset: 7 }, { blockId: passage.id, offset: 10 });
  assert.equal(anchor.quote, "x^2");
  assert.deepEqual(resolveAnchor(document, anchor), anchor);
  const engine = new DocumentEngine(document);
  assert.equal(engine.search("after").length, 1);
});

test("HTML resolves resources against an HTTP base, retaining local image placeholders without app-relative loads", () => {
  const document = html(`<head><base href="https://example.org/book/"></head><p><a href="chapter.html">Chapter</a><a href="#target">Here</a>
    <img src="images/a.png" alt="A"><img srcset="https://example.org/one.png 1x, https://example.org/two.png 2x" alt="B"></p>`);
  const all = nodes(document);
  assert.ok(all.some((node) => node.type === "element" && node.href === "https://example.org/book/chapter.html"));
  assert.ok(all.some((node) => node.type === "element" && node.href === "#target"));
  assert.deepEqual(document.objects.map((object) => object.src), ["https://example.org/book/images/a.png", "https://example.org/two.png"]);
  const local = html('<base href="file:///tmp/"><img src="images/local.png" alt="Local"><img src="data:image/png;base64,AAAA" alt="Inline">');
  assert.deepEqual(local.objects.map((object) => object.src), ["images/local.png", "data:image/png;base64,AAAA"]);
});

test("HTML internal links preserve custom IDs, footnotes, encoded fragments and collision-free generated headings", () => {
  const document = html('<div id="chapter"><h1 id="custom">Study</h1><h2>Notes</h2><p id="notes">Before <span id="foot note">footnote</span> after.</p><h2>Notes</h2><a name="legacy">Legacy target</a><p><a href="#legacy"><span id="link-label">Link label</span></a></p></div>');
  assert.deepEqual(document.outline.map((heading) => heading.id), ["custom", "notes-1", "notes-2"]);
  const footnote = fragmentAnchor(document, "#foot%20note")!;
  assert.equal(footnote.quote, "footnote");
  assert.equal(footnote.start.offset, 7);
  assert.ok(resolveAnchor(document, footnote));
  assert.ok(fragmentAnchor(document, "#chapter"));
  assert.equal(fragmentAnchor(document, "#legacy")?.quote, "Legacy target");
  assert.equal(fragmentAnchor(document, "#link-label")?.quote, "Link label");
  assert.ok(!nodes(document).some((node) => node.type === "element" && node.tag === "a" && node.children.some((child) => child.type === "element" && child.tag === "a")));
  assert.equal(fragmentAnchor(document, "#missing"), null);
});

test("HTML decoding supports declared encodings and rejects binary files", () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>Caf'), 0xe9, ...new TextEncoder().encode('</p>')]);
  const document = htmlAdapter.parse({ id: "encoding", fileName: "cafe.htm", bytes }) as FlowDocument;
  assert.equal(document.blocks[0].text, "Café\n");
  assert.throws(() => html("<p>binary\0</p>"), /binary/);
});

test("HTML import keeps bytes, deduplicates and relinks backed-up annotations", async () => {
  for (const name of ["notes.HTML", "notes.htm", "notes.xhtml"]) assert.equal(nativeDocumentFormat({ name }), "html");
  assert.equal(nativeDocumentFormat({ name: "download", type: "text/html; charset=utf-8" }), "html");
  assert.ok(DOCUMENT_FILE_ACCEPT.includes(".html"));
  const source = '<!doctype html><html><head><title>HTML import</title></head><body><h1>Notes</h1><p>Preserve this passage.</p></body></html>';
  const file = new File([source], "notes.html", { type: "text/html" });
  const storage = createMemoryStorage();
  const imported = await importFiles(storage, [file]);
  assert.deepEqual(imported.failed, []);
  const meta = imported.added[0];
  assert.equal(meta.format, "html");
  assert.equal(meta.title, "HTML import");
  assert.equal(meta.pageCount, undefined);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual(await storage.getFile(meta.docId), bytes);
  assert.equal((await importFiles(storage, [new File([source], "renamed.htm")])).alreadyThere[0].docId, meta.docId);
  const document = await parseDocument("html", { id: meta.docId, bytes, fileName: file.name });
  const anchor = new DocumentEngine(document).search("Preserve this passage")[0].anchor;
  await storage.putData(meta.docId, "nativeAnnotations", [{ id: "highlight", anchor, comment: "Saved HTML note" }]);
  const restored = createMemoryStorage();
  await importNotes(restored, await exportNotes(storage));
  assert.equal((await restored.getMeta(meta.docId))?.fileMissing, true);
  assert.equal((await importFiles(restored, [file])).added[0].fileMissing, undefined);
  assert.deepEqual(await restored.getData(meta.docId, "nativeAnnotations"), [{ id: "highlight", anchor, comment: "Saved HTML note" }]);
  releaseDocument(meta.docId);
});
