import test from "node:test";
import assert from "node:assert/strict";
import { htmlAdapter } from "../html/adapter.ts";
import { DocumentEngine } from "./engine.ts";
import { anchorText } from "./anchors.ts";
import { mediaUrl, playerUrl } from "./media.ts";
import { nativeDivePanels, nativeSummaryStore } from "./nativeDives.ts";
import { ancestorChain, rootPanelOf, treeOf } from "../deepdive/tree.ts";
import type { FlowDocument, FlowNode, DocumentAnnotation } from "./model.ts";
import type { AskThread } from "../ask/types.ts";
import { annotatedHTML } from "./export.ts";
import { textBody, type NotebookDocument } from "../notebook/model.ts";

const parse = (source: string) => htmlAdapter.parse({ id: "native", fileName: "test.html", bytes: new TextEncoder().encode(source) }) as FlowDocument;
function nodes(document: FlowDocument) {
  const out: FlowNode[] = [];
  const visit = (node: FlowNode) => { out.push(node); if (node.type === "element") node.children.forEach(visit); };
  document.blocks.forEach((block) => visit(block.content)); return out;
}
test("native media accepts direct web sources and narrowly scoped players", () => {
  assert.equal(playerUrl("https://youtu.be/abcdef12345?t=20"), "https://www.youtube-nocookie.com/embed/abcdef12345");
  assert.equal(playerUrl("https://vimeo.com/1234567"), "https://player.vimeo.com/video/1234567");
  for (const url of ["javascript:alert(1)", "file:///tmp/a.mp4", "https://user:pass@youtube.com/watch?v=abcdef12345", "https://youtube.com.evil.invalid/embed/abcdef12345", "https://evil.invalid/player"]) assert.equal(playerUrl(url), null, url);
  assert.equal(mediaUrl("https://example.org/video.mp4"), "https://example.org/video.mp4");
  assert.equal(mediaUrl("https://user:secret@example.org/video.mp4"), null);
  const document = parse('<base href="https://example.org/articles/"><video poster="/poster.png"><source src="film.mp4"></video><audio src="sound.mp3"></audio><iframe src="https://www.youtube.com/embed/abcdef12345" title="Lecture"></iframe><iframe src="https://evil.invalid/active" title="External item"></iframe>');
  assert.deepEqual(document.objects.map((object) => object.kind), ["video", "audio", "embed"]);
  assert.ok(nodes(document).some((node) => node.type === "media" && node.src === "https://example.org/articles/film.mp4"));
  assert.ok(!nodes(document).some((node) => node.type === "media" && node.src.includes("evil.invalid")));
});
test("inline SVG keeps diagrams while stripping scripts, HTML, style URLs and external references", async () => {
  const document = parse('<svg viewBox="0 0 80 40" onload="bad()"><title>Chart</title><script>secret-code</script><foreignObject><div>secret-html</div></foreignObject><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="80" height="40" fill="url(#g)"/><use href="https://evil.invalid/image.svg#x"/><text x="4" y="20">Curve</text></svg>');
  const svg = await [...document.assets!.values()][0].text();
  assert.match(svg, /viewBox="0 0 80 40"/);
  assert.match(svg, /linearGradient/);
  assert.match(svg, /url\(#g\)/);
  for (const forbidden of ["secret", "script", "foreignObject", "onload", "evil.invalid"]) assert.ok(!svg.includes(forbidden), forbidden);
  assert.ok(!document.blocks[0].text.includes("secret"));
  assert.match(document.blocks[0].text, /ChartCurve/);
});
test("HTML retains table spans and task state without retaining form controls", () => {
  const document = parse('<table><tr><th colspan="2">Title</th></tr><tr><td rowspan="2">A</td><td>B</td></tr></table><ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Pending</li></ul>');
  assert.ok(nodes(document).some((node) => node.type === "element" && node.colSpan === 2));
  assert.ok(nodes(document).some((node) => node.type === "element" && node.rowSpan === 2));
  assert.match(document.blocks.at(-1)!.text, /\[x\] Done\n\[ \] Pending/);
});
test("cross references resolve native figure, theorem, equation and bibliography anchors without PDF geometry", async () => {
  const document = parse('<h1>Results</h1><p>Figure 1. A measured curve.</p><p>Theorem 2. All values are positive.</p><p>x = y (3)</p><p>See Figure 1, Theorem 2 and Eq. (3), also [1].</p><h2>References</h2><p>[1] Smith, A. A useful paper.</p><p>[2] Jones, B. A second paper.</p>');
  const engine = new DocumentEngine(document);
  const references = await engine.getReferences();
  for (const label of ["Figure 1", "Theorem 2", "(3)", "[1]"]) assert.ok(references.some((ref) => anchorText(document, ref.anchor).includes(label)), label);
  assert.ok(references.every((ref) => ref.targets.every((target) => anchorText(document, target.anchor).length)));
  assert.equal(await engine.getReferences(), references);
});
test("native dive projection preserves conversation identity, summaries, streaming and orphaned threads", () => {
  const engine = new DocumentEngine(parse('<h1>Chapter</h1><p>A useful passage.</p>'));
  const thread = (id: string, extra: Partial<AskThread> = {}): AskThread => ({ id, title: id, mode: "dive", turns: [], createdAt: "2026-11-16", updatedAt: "2026-11-16", ...extra });
  const root = thread("root", { anchor: engine.search("useful")[0].anchor, summary: { content: "Summary", sources: [], at: "now", turnCount: 1 } });
  const { panels, jobs } = nativeDivePanels([root, thread("child", { parentThreadId: "root", turns: [{ id: "turn", role: "assistant", content: "Partial", at: "now", status: "streaming" }] }), thread("orphan", { parentThreadId: "missing" }), thread("ask", { mode: undefined })], engine);
  assert.deepEqual(panels.map((panel) => panel.id), ["root", "child", "orphan"]);
  assert.equal(panels[0].selection, "useful");
  assert.equal(panels[0].locationLabel, "Chapter");
  assert.equal(panels[0].summary?.content, "Summary");
  assert.equal(panels[2].parentId, null);
  assert.equal(jobs.child.text, "Partial");
  assert.equal(panels[1].turns.length, 0);
  const cyclic = [{ ...panels[0], parentId: "child" }, panels[1]];
  assert.equal(rootPanelOf(cyclic, "root"), null);
  assert.equal(ancestorChain(cyclic, "root", "Source").length, 3);
  assert.equal(treeOf(cyclic, "root").length, 2);
});
test("annotated export includes native math, object marks, embedded SVG, and editable notebook writing safely", async () => {
  const document = parse('<h1>Study &amp; notes</h1><p>Mark this <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>.</p><svg viewBox="0 0 20 20"><rect width="20" height="20" fill="red"/></svg>');
  const engine = new DocumentEngine(document), object = document.objects[0];
  const annotation = (id: string, anchor: DocumentAnnotation["anchor"], color: string): DocumentAnnotation => ({ id, kind: "highlight", anchor, color, style: "highlight", text: "", comment: "", createdAt: "now" });
  const notebook: NotebookDocument = { schemaVersion: 1, migrated: true, docId: document.id, revision: 1, sections: [{ id: "document", title: "My writing" }], captures: [], entries: [{ id: "entry", sectionId: "document", body: textBody("Saved <script> text"), captureIds: [], createdAt: "now", updatedAt: "now" }] };
  const html = await annotatedHTML(document, [annotation("text", engine.search("Mark this")[0].anchor, "red;position:fixed"), annotation("math", engine.search("x^2")[0].anchor, "#ffe08a"), annotation("figure", { kind: "object", objectId: object.id, blockId: object.blockId }, "#ff0000")], notebook, []);
  assert.match(html, /<mark style="background:#ffe08a/);
  assert.match(html, /<math/);
  assert.match(html, /data:image\/svg\+xml;base64,/);
  assert.match(html, /outline:3px solid #ff0000/);
  assert.match(html, /Saved &lt;script&gt; text/);
  assert.ok(!html.includes("position:fixed") && !html.includes("<script>"));
  const bare = parse('<img src="data:image/png;base64,AAAA" alt="">'), bareObject = bare.objects[0];
  const bareHTML = await annotatedHTML(bare, [annotation("empty-alt", { kind: "object", blockId: bareObject.blockId, objectId: bareObject.id }, "#ff0000")], notebook, []);
  assert.match(bareHTML, /outline:3px solid #ff0000/, "objects with empty canonical text still export their marks");
});
test("summary progress survives view subscriptions and remains scoped to its document", () => {
  const document = {} as Parameters<typeof nativeSummaryStore>[0];
  const state = nativeSummaryStore(document);
  let notifications = 0;
  const remove = state.subscribe(() => { notifications++; });
  state.set(() => ({ root: { phase: "streaming", text: "Partial", sources: [] } }));
  remove();
  assert.equal(notifications, 1);
  assert.equal(nativeSummaryStore(document).getSnapshot().root.text, "Partial");
  assert.deepEqual(nativeSummaryStore({} as typeof document).getSnapshot(), {});
  state.set(() => ({}));
  assert.equal(notifications, 1);
});
