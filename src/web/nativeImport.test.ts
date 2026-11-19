import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { addFromUrl, findSaved } from "./index.ts";
import { createMemoryStorage } from "../storage/memory.ts";
import { computeDocId, importDocument } from "../storage/documents.ts";
import { exportNotes, importNotes } from "../library/library.ts";
import { parseDocument, releaseDocument } from "../document/registry.ts";
import { fragmentAnchor } from "../document/anchors.ts";
import type { FlowNode } from "../document/model.ts";
import type { WebFetcher } from "./types.ts";
import type { PageRenderer } from "./renderer.ts";
import { saveImages } from "./assets.ts";
import { articleSnapshot } from "./snapshot.ts";
import { emptyReport } from "./types.ts";

const parser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
before(() => Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true }));
after(() => { if (parser) Object.defineProperty(globalThis, "DOMParser", parser); else Reflect.deleteProperty(globalThis, "DOMParser"); });
const PAGE = "https://example.org/blog/article";
const IMAGE = "https://example.org/images/plot.png";
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
const prose = Array.from({ length: 6 }, (_, i) => `<p>Passage ${i} explains native article reading with searchable text, careful source preservation, and durable highlights. This substantial paragraph helps the article extractor identify the main document and retain its surrounding context.</p>`).join("");

test("rendered browser imports use captured DOM without fetching the blocked page again and preserve supported players", async () => {
  const storage = createMemoryStorage();
  const fetcher: WebFetcher = {
    async fetch() { throw new Error("A browser-captured page must not be fetched again"); },
    assetUrl(url) { return url; },
  };
  const renderer: PageRenderer = { async render() { throw new Error("This fixture needs no figure rendering"); } };
  const result = await addFromUrl(storage, "https://example.org/blocked", { fetcher, renderer, renderedPage: { url: PAGE, title: "Rendered", contentType: "text/html", html: `<html><head><title>Rendered</title></head><body><article><h1>Rendered</h1>${prose}<video src="https://example.org/film.mp4" title="Lecture"></video><audio src="https://example.org/clip.mp3"></audio><iframe src="https://www.youtube.com/embed/abcdef12345" title="Video"></iframe><script>bad()</script></article></body></html>` } });
  assert.equal(result.status, "added");
  assert.equal(result.meta.format, "html");
  assert.equal(result.meta.source?.url, "https://example.org/blocked");
  assert.equal(result.meta.source?.finalUrl, PAGE);
  const bytes = (await storage.getFile(result.meta.docId))!;
  const saved = new TextDecoder().decode(bytes);
  assert.ok(!saved.includes("<script"));
  const document = await parseDocument("html", { id: result.meta.docId, fileName: result.meta.fileName, bytes });
  assert.deepEqual(document.objects.map((object) => object.kind), ["video", "audio", "embed"]);
  if (result.status === "added") assert.deepEqual(result.report?.media, []);
  releaseDocument(document.id);
});
const source = (extra = "") => `<!doctype html><html><head><title>Native URL article</title><meta name="author" content="Ada Reader"><meta property="og:site_name" content="Example"><link rel="canonical" href="${PAGE}"></head><body><nav>Navigation junk</nav><article><h1 id="article-title">Native URL article</h1>${prose}<h2 id="results">Results</h2><p>An equation <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math> follows.</p><p><a href="${PAGE}#results">Jump to results</a> and <a href="/references">external reference</a>.</p><figure><img src="/images/plot.png" alt="Training plot"><figcaption>Measured results</figcaption></figure><table><tr><th>Score</th><th>Value</th></tr><tr><td>A</td><td>42</td></tr></table>${extra}</article><script>window.evil=true</script></body></html>`;
function fetcher(html = source(), failImage = false) {
  const calls: { url: string; purpose: string }[] = [];
  const mock: WebFetcher = {
    assetUrl: (url) => url,
    async fetch(url, options) {
      calls.push({ url, purpose: options.purpose });
      if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (options.purpose === "asset") {
        if (failImage) throw new Error("Image unavailable");
        assert.equal(url, IMAGE);
        assert.equal(options.referer, PAGE);
        return { url, finalUrl: url, contentType: "image/png", bytes: png };
      }
      return { url, finalUrl: PAGE, contentType: "text/html", bytes: new TextEncoder().encode(html) };
    },
  };
  return { mock, calls };
}
const noRender: PageRenderer = { async open() { throw new Error("This plain article must not need a styled render"); } };

test("URL articles persist self-contained native HTML, metadata, headings, math and offline images", async () => {
  const storage = createMemoryStorage();
  const { mock, calls } = fetcher();
  const stages: string[] = [];
  const result = await addFromUrl(storage, PAGE + "?utm_source=test", { fetcher: mock, renderer: noRender, onProgress: (progress) => stages.push(progress.stage) });
  assert.equal(result.status, "added");
  const meta = result.meta;
  assert.equal(meta.format, "html");
  assert.equal(meta.fileName, "Native URL article.html");
  assert.equal(meta.title, "Native URL article");
  assert.equal(meta.author, "Ada Reader");
  assert.equal(meta.source?.canonicalUrl, PAGE);
  assert.equal(meta.source?.format, "article");
  assert.equal(meta.pageCount, undefined);
  assert.ok(!stages.includes("layout"));
  assert.equal(calls.filter((call) => call.purpose === "asset").length, 1);
  const bytes = (await storage.getFile(meta.docId))!;
  assert.equal(await computeDocId(bytes), meta.docId);
  const saved = new TextDecoder().decode(bytes);
  assert.match(saved, /data:image\/png;base64,/);
  assert.ok(!saved.includes("Navigation junk") && !saved.includes("window.evil") && !saved.includes("<script"));
  assert.ok(!saved.includes("data-kr-id"));
  releaseDocument(meta.docId);
  const document = await parseDocument("html", { id: meta.docId, fileName: meta.fileName, bytes });
  assert.ok(fragmentAnchor(document, "#results"));
  assert.ok(fragmentAnchor(document, "#article-title"));
  assert.deepEqual(document.objects.map((object) => object.kind), ["image", "table"]);
  const all: FlowNode[] = [];
  const visit = (node: FlowNode) => { all.push(node); if (node.type === "element") node.children.forEach(visit); };
  document.blocks.forEach((block) => visit(block.content));
  assert.deepEqual(all.filter((node) => node.type === "math").map((node) => node.value), ["x^2"]);
  assert.ok(all.some((node) => node.type === "element" && node.href === "https://example.org/references"));
  assert.ok(all.some((node) => node.type === "element" && node.href === "#results"));
  assert.ok(document.objects[0].src?.startsWith("data:image/png;base64,"));
  if (result.status === "added") assert.equal(result.report?.mathAsTex, 0);
});

test("unchanged URL fetches deduplicate across saved dates and preserve annotations; edited pages get a new identity", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2000, 0, 1) });
  const storage = createMemoryStorage();
  const first = await addFromUrl(storage, PAGE, { fetcher: fetcher().mock, renderer: noRender });
  await storage.putData(first.meta.docId, "nativeAnnotations", [{ id: "note", comment: "Keep my note" }]);
  await storage.putMeta({ ...first.meta, title: "My article", source: { ...first.meta.source!, fetchedAt: "2000-01-01T00:00:00Z" } });
  context.mock.timers.tick(24 * 60 * 60 * 1000);
  const duplicate = await addFromUrl(storage, PAGE, { force: true, fetcher: fetcher().mock, renderer: noRender });
  assert.equal(duplicate.status, "existing");
  assert.equal(duplicate.meta.docId, first.meta.docId);
  assert.equal(duplicate.meta.title, "My article");
  assert.deepEqual(await storage.getData(first.meta.docId, "nativeAnnotations"), [{ id: "note", comment: "Keep my note" }]);
  const restored = createMemoryStorage();
  await importNotes(restored, await exportNotes(storage));
  const relinked = await addFromUrl(restored, PAGE, { fetcher: fetcher().mock, renderer: noRender });
  assert.equal(relinked.meta.docId, first.meta.docId);
  assert.equal(relinked.meta.fileMissing, undefined);
  assert.equal(relinked.meta.title, "My article");
  assert.deepEqual(await restored.getData(first.meta.docId, "nativeAnnotations"), [{ id: "note", comment: "Keep my note" }]);
  const changed = await addFromUrl(storage, PAGE, { force: true, fetcher: fetcher(source("<p>A newly added conclusion.</p>")).mock, renderer: noRender });
  assert.equal(changed.status, "added");
  assert.notEqual(changed.meta.docId, first.meta.docId);
  assert.equal((await findSaved(storage, PAGE))?.docId, changed.meta.docId);
});

test("direct EPUB URLs retain the converted EPUB path and reuse existing library files", async () => {
  const storage = createMemoryStorage();
  const epub = new TextEncoder().encode("PK existing EPUB source");
  const docId = await computeDocId(epub);
  const meta = (await importDocument(storage, { bytes: new TextEncoder().encode("stored PDF bytes"), fileName: "Existing.epub", docId })).meta;
  const result = await addFromUrl(storage, PAGE, { fetcher: { ...fetcher().mock, async fetch(url) { return { url, finalUrl: url, contentType: "application/epub+zip", bytes: epub }; } } });
  assert.equal(result.status, "existing");
  assert.equal(result.meta.docId, meta.docId);
  assert.equal(result.meta.format, undefined);
});

test("failed article images leave a visible source link and an import report", async () => {
  const result = await addFromUrl(createMemoryStorage(), PAGE, { fetcher: fetcher(source(), true).mock, renderer: noRender });
  assert.equal(result.status, "added");
  if (result.status === "added") assert.deepEqual(result.report?.imagesFailed, [{ url: IMAGE, alt: "Training plot" }]);
});

test("unavailable script-created images keep an explicit fallback without failing the article", async () => {
  const content = new DOMParser().parseFromString('<html><body><p><img src="blob:https://example.org/temporary" alt="Dynamic picture"></p></body></html>', "text/html").body;
  const files = new Map<string, Uint8Array>();
  const report = emptyReport();
  await saveImages(content, { fetcher: fetcher().mock, pageUrl: PAGE, files, report, native: true });
  assert.deepEqual(report.imagesFailed, [{ url: PAGE, alt: "Dynamic picture" }]);
  const saved = new TextDecoder().decode(articleSnapshot({ content, files, report, meta: { title: "Dynamic image", authors: [] } }, PAGE));
  assert.match(saved, /Picture not saved \(Dynamic picture\)/);
  assert.ok(!saved.includes("blob:"));
});

test("CSS figures and SVG are saved as native raster objects with searchable labels", async () => {
  let closed = false;
  const renderer: PageRenderer = { async open() { return {
    close() { closed = true; }, async snapshot() { return { png, width: 400, height: 200 }; },
    async size() { return { width: 400, height: 200 }; }, async standaloneSvg() { throw new Error("Native figures use raster snapshots"); },
  }; } };
  const storage = createMemoryStorage();
  const extra = '<figure><div>Input node</div><div>Reasoning node</div><div>Output node</div><figcaption>A CSS diagram</figcaption></figure><figure><svg width="400" height="200"><text>Vector diagram</text></svg><figcaption>Vector result</figcaption></figure>';
  const result = await addFromUrl(storage, PAGE, { fetcher: fetcher(source(extra)).mock, renderer });
  assert.equal(closed, true);
  assert.equal(result.status, "added");
  if (result.status === "added") assert.equal(result.report?.figuresCaptured, 2);
  const bytes = (await storage.getFile(result.meta.docId))!;
  const document = await parseDocument("html", { id: result.meta.docId, fileName: result.meta.fileName, bytes });
  assert.equal(document.objects.filter((object) => object.kind === "image").length, 3);
  const text = document.blocks.map((block) => block.text).join("\n");
  assert.match(text, /Input node Reasoning node Output node/);
  assert.match(text, /Vector diagram/);
  assert.ok(!new TextDecoder().decode(bytes).includes("<svg"));
});

test("cancelled URL imports save no document", async () => {
  const storage = createMemoryStorage();
  const controller = new AbortController();
  await assert.rejects(addFromUrl(storage, PAGE, {
    fetcher: fetcher().mock, renderer: noRender, signal: controller.signal,
    onProgress: (progress) => { if (progress.stage === "images") controller.abort(); },
  }), { name: "AbortError" });
  assert.deepEqual(await storage.listDocuments(), []);
});

test("saved legacy PDF articles remain intact and a fresh native copy becomes the preferred URL match", async () => {
  const storage = createMemoryStorage();
  const legacy = (await importDocument(storage, { bytes: new TextEncoder().encode("legacy PDF bytes"), fileName: "article.pdf" })).meta;
  await storage.putMeta({ ...legacy, source: { kind: "web", format: "article", url: PAGE, finalUrl: PAGE, canonicalUrl: PAGE, fetchedAt: "2000-01-01T00:00:00Z" } });
  const existing = await addFromUrl(storage, PAGE, { fetcher: { ...fetcher().mock, async fetch() { throw new Error("Saved copy should not fetch"); } } });
  assert.equal(existing.meta.docId, legacy.docId);
  const fresh = await addFromUrl(storage, PAGE, { force: true, fetcher: fetcher().mock, renderer: noRender });
  assert.equal(fresh.meta.format, "html");
  assert.notEqual(fresh.meta.docId, legacy.docId);
  assert.equal((await findSaved(storage, PAGE))?.docId, fresh.meta.docId);
  assert.equal((await storage.getMeta(legacy.docId))?.format, undefined);
  assert.equal((await storage.listDocuments()).length, 2);
});
