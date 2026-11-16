import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildTextIndex } from "../glossary/textIndex.ts";
import { ASK_BUDGET } from "../grounding/ask.ts";
import type { Attachment } from "../grounding/attachments.ts";
import { chunkDocument } from "../text/chunks.ts";
import type { DiveRequestContext } from "./diveRequest.ts";
import type { DivePanel } from "./types.ts";

// Bundle the browser request builder's extensionless imports, as in the app.
const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "dive-request-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = join(directory, "request.mjs");
await build({
  stdin: { contents: `
    export { prepareDiveSources } from "./src/deepdive/diveRequest.ts";
    export { buildDivePrompt } from "./src/deepdive/prompts.ts";
    export { DEFAULT_EXPERIMENTS, PRODUCTION_EXPERIMENTS } from "./src/deepdive/experiments.ts";
  `, resolveDir: root },
  outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent",
});
const { prepareDiveSources, buildDivePrompt, DEFAULT_EXPERIMENTS, PRODUCTION_EXPERIMENTS } = await import(pathToFileURL(outfile).href);

const paper = [
  "The opening introduces bounded sequences and gives the assumptions of the theorem.",
  "The selected passage proves convergence using the earlier assumptions.",
  "The final discussion describes applications that share no words with the selection.",
  "References. Smith, A. An earlier result about compact spaces.",
];

function setup(texts = paper) {
  const index = buildTextIndex(texts.map((text, i) => ({
    pageNumber: i + 1, width: 600, height: 800,
    textItems: [{ text, index: 0, pageNumber: i + 1, rect: { left: 72, top: 100, width: 450, height: 12, pageNumber: i + 1 } }],
  })));
  const chunks = chunkDocument(index);
  // Supply pre-extracted PDF pages without starting a browser or PDF worker.
  const provider = { kind: "flow", numPages: texts.length, getTextIndex: async () => index, getSections: async () => [] };
  const panel: DivePanel = {
    id: "root", parentId: null, anchorHighlightId: null, pageNumber: 2,
    selection: "The selected passage", label: "Selected passage", contextText: "", turns: [], createdAt: "",
  };
  const context: DiveRequestContext = {
    pdf: provider as unknown as PDFDocumentProxy, pageLabel: String, panels: [panel], highlights: [], glossary: [],
    experiments: PRODUCTION_EXPERIMENTS,
  };
  return { index, chunks, panel, context };
}

const opening = { reuse: false, attachments: [] };
const promptFor = (panel: DivePanel, prepared: Awaited<ReturnType<typeof prepareDiveSources>>) =>
  buildDivePrompt("paper.pdf", panel, null, { sources: prepared.sources, pageLabel: String }, { splitAt: prepared.splitAt });

test("a small PDF dive includes every page, including unrelated passages and references, with exact citation offsets", async () => {
  const { index, chunks, panel, context } = setup();
  const prepared = await prepareDiveSources(context, panel, "Explain the selected passage.", opening);
  assert.deepEqual(prepared.sources.map((source) => source.chunkId), chunks.map((chunk) => chunk.id));
  assert.deepEqual(prepared.sources.map((source) => source.label), chunks.map((_, i) => `S${i + 1}`));
  for (const source of prepared.sources) {
    assert.equal(source.text, index.pages[source.pageNumber - 1].text.slice(source.start, source.end));
  }
  const prompt = promptFor(panel, prepared);
  for (const text of paper) assert.ok(prompt.system.includes(text));
  assert.equal(prompt.suffix, "");
});

test("the whole-document cutoff is inclusive and exceeds the retrieval ceiling", async () => {
  const { chunks, panel, context } = setup(["a".repeat(30_000), "b".repeat(30_000)]);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), ASK_BUDGET.wholeScopeChars);
  const prepared = await prepareDiveSources(context, panel, "A query absent from the text", opening);
  assert.equal(prepared.sources.reduce((sum, source) => sum + source.text.length, 0), 60_000);
  assert.equal(prepared.sources.length, chunks.length);
});

test("a PDF just above the cutoff keeps retrieval even when it has only two pages", async () => {
  const selected = "A needle appears here.";
  const { panel, context } = setup(["x".repeat(ASK_BUDGET.wholeScopeChars + 1 - selected.length), selected]);
  context.experiments = DEFAULT_EXPERIMENTS;
  panel.selection = "needle";
  const prepared = await prepareDiveSources(context, panel, "Explain the needle.", opening);
  assert.deepEqual(prepared.sources.map((source) => source.pageNumber), [2]);
});

test("small-document follow-ups keep the entire source prefix identical without duplicated chunks", async () => {
  const { chunks, panel, context } = setup();
  const first = await prepareDiveSources(context, panel, "Explain the selected passage.", opening);
  panel.baseSources = first.sources;
  panel.turns = [{ role: "user", content: "Explain.", at: "" }, { role: "assistant", content: "An explanation [S2].", sources: first.sources, at: "" }];
  const next = await prepareDiveSources(context, panel, "What about the applications?", opening);
  assert.deepEqual(next.sources, first.sources);
  assert.equal(new Set(next.sources.map((source) => source.chunkId)).size, chunks.length);
  assert.equal(promptFor(panel, next).system, promptFor(panel, first).system);
  const wider = await prepareDiveSources(context, panel, "Search wider", { ...opening, wider: true });
  assert.deepEqual(wider.sources, first.sources);
});

test("nested and image-only dives also receive the complete small document", async () => {
  const { chunks, panel, context } = setup();
  for (const dive of [
    { ...panel, id: "nested", parentId: panel.id, pageNumber: undefined, selection: "an idea from the earlier answer" },
    { ...panel, selection: "", selectionImage: { mediaType: "image/png", data: "region" } },
  ]) {
    context.panels = [panel, dive];
    const prepared = await prepareDiveSources(context, dive, "Explain this.", opening);
    assert.deepEqual(prepared.sources.map((source) => source.chunkId), chunks.map((chunk) => chunk.id));
  }
});

test("attached excerpts keep their source while retaining the rest of the overlapping chunk", async () => {
  const { chunks, panel, context } = setup();
  const attachment: Attachment = { id: "excerpt", kind: "document", pageNumber: 2, text: "proves convergence" };
  const first = await prepareDiveSources(context, panel, "Explain this excerpt", { reuse: false, attachments: [attachment] });
  assert.deepEqual(first.sources.filter((source) => source.chunkId).map((source) => source.chunkId), chunks.map((chunk) => chunk.id));
  assert.equal(first.sources.filter((source) => source.via === "attached").length, 1);
  panel.baseSources = first.sources;
  panel.turns = [{ role: "assistant", content: "An explanation.", sources: first.sources, at: "" }];
  const next = await prepareDiveSources(context, panel, "Explain it again", { reuse: false, attachments: [attachment] });
  assert.deepEqual(next.sources, first.sources);
  assert.equal(promptFor(panel, next).system, promptFor(panel, first).system);

  const added = await prepareDiveSources(context, panel, "Explain another excerpt", {
    reuse: false, attachments: [{ id: "ending", kind: "document", pageNumber: 3, text: "final discussion" }],
  });
  assert.deepEqual(added.sources.slice(0, first.sources.length), first.sources);
  assert.equal(promptFor(panel, added).system, promptFor(panel, first).system);
  assert.match(promptFor(panel, added).suffix, /final discussion/);
});

test("saved dives with partial sources expand to the whole small document, including on More detail", async () => {
  const { chunks, panel, context } = setup();
  const selected = chunks.find((chunk) => chunk.pageNumber === 2)!;
  const base = [{ label: "S1", chunkId: selected.id, pageNumber: selected.pageNumber, start: selected.start, end: selected.end, text: selected.text }];
  panel.baseSources = base;
  panel.turns = [{ role: "assistant", content: "An earlier explanation [S1].", sources: base, at: "" }];
  for (const reuse of [false, true]) {
    const prepared = await prepareDiveSources(context, panel, "More detail, please.", { reuse, attachments: [] });
    assert.deepEqual(prepared.sources.slice(0, base.length), base);
    assert.deepEqual(new Set(prepared.sources.map((source) => source.chunkId)), new Set(chunks.map((chunk) => chunk.id)));
    assert.equal(prepared.splitAt, base.length);
  }
});

test("whole-document context also applies when the stable-sources experiment is off", async () => {
  const { chunks, panel, context } = setup();
  context.experiments = DEFAULT_EXPERIMENTS;
  const prepared = await prepareDiveSources(context, panel, "Explain this.", opening);
  assert.deepEqual(prepared.sources.map((source) => source.chunkId), chunks.map((chunk) => chunk.id));
  assert.equal(prepared.splitAt, undefined);
});

test("reuse can still use a saved answer's sources when text extraction fails", async () => {
  const { panel, context } = setup();
  const sources = [{ label: "S1", pageNumber: 2, start: 0, end: 5, text: "Saved" }];
  panel.baseSources = sources;
  panel.turns = [{ role: "assistant", content: "Saved answer [S1].", sources, at: "" }];
  context.pdf = { kind: "flow", getTextIndex: async () => { throw new Error("Unreadable PDF"); } } as unknown as PDFDocumentProxy;
  const prepared = await prepareDiveSources(context, panel, "More detail", { reuse: true, attachments: [] });
  assert.deepEqual(prepared.sources, sources);
  assert.equal(prepared.splitAt, sources.length);
});
