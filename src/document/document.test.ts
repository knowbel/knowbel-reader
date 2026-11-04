import test from "node:test";
import assert from "node:assert/strict";
import { markdownAdapter } from "../markdown/adapter.ts";
import { DocumentEngine } from "./engine.ts";
import { anchorRanges, anchorText, resolveAnchor, textAnchor } from "./anchors.ts";
import type { FlowDocument, TextAnchor } from "./model.ts";
import { findTermMatches } from "../glossary/textIndex.ts";
import { chunkDocument } from "../text/chunks.ts";
import { buildBm25 } from "../grounding/retrieval.ts";
import { selectAskSources } from "../grounding/ask.ts";
import { sourceChipLabel, toChipMarkdown } from "../grounding/citations.ts";
import { renderSources } from "../grounding/prompt.ts";
import { attachmentSources } from "../grounding/attachments.ts";

const parse = (source: string) => markdownAdapter.parse({ id: "d".repeat(64), bytes: new TextEncoder().encode(source), fileName: "Notes.md" }) as FlowDocument;

test("anchors distinguish repeated passages and survive serialization and reflow", () => {
  const document = parse("# Notes\n\nSame passage. Same passage.\n\nSame passage.");
  const block = document.blocks[1];
  const anchor = textAnchor(document, { blockId: block.id, offset: 14 }, { blockId: block.id, offset: 26 });
  assert.equal(anchor.quote, "Same passage");
  assert.equal(anchorText(document, anchor), "Same passage");
  assert.deepEqual(resolveAnchor(document, JSON.parse(JSON.stringify(anchor))), anchor);
  const reopened = parse("# Notes\n\nSame passage. Same passage.\n\nSame passage.");
  assert.deepEqual(resolveAnchor(reopened, anchor), anchor);
  assert.notEqual(document.blocks[1].id, document.blocks[2].id);
});

test("multi-block selections keep exact text and offsets across inline formatting", () => {
  const document = parse("# Notes\n\nFirst **formatted** paragraph.\n\nSecond paragraph with $x^2$.");
  const [first, second] = document.blocks.slice(1);
  const anchor = textAnchor(document, { blockId: first.id, offset: 6 }, { blockId: second.id, offset: 16 });
  assert.equal(anchor.quote, "formatted paragraph.\n\nSecond paragraph");
  assert.deepEqual(anchorRanges(document, anchor), [{ blockId: first.id, start: 6, end: first.text.length }, { blockId: second.id, start: 0, end: 16 }]);
  assert.deepEqual(resolveAnchor(document, anchor), anchor);
});

test("quote recovery requires unambiguous context and never guesses between duplicates", () => {
  const document = parse("prefix target suffix");
  const block = document.blocks[0];
  const anchor = textAnchor(document, { blockId: block.id, offset: 7 }, { blockId: block.id, offset: 13 });
  const moved = parse("# Inserted\n\nprefix target suffix");
  assert.ok(resolveAnchor(moved, anchor));
  const missing = { ...anchor, start: { blockId: "gone", offset: 0 }, end: { blockId: "gone", offset: 6 } };
  assert.equal((resolveAnchor(moved, missing) as TextAnchor).quote, "target");
  assert.equal(resolveAnchor(parse("prefix target suffix\n\nprefix target suffix"), missing), null);
  assert.equal(resolveAnchor(parse("prefix other suffix"), missing), null);
});

test("object anchors resolve images without alt text and tables without PDF rectangles", () => {
  const document = parse("![](image.png)\n\n| a | b |\n| - | - |\n| c | d |");
  const image = document.objects[0];
  const anchor = { kind: "object" as const, objectId: image.id, blockId: image.blockId };
  assert.deepEqual(resolveAnchor(document, anchor), anchor);
  assert.equal(anchorText(document, anchor), "");
  assert.equal(resolveAnchor(document, { ...anchor, objectId: "gone" }), null);
});

test("collapsed reading positions resolve without needing a text quotation", () => {
  const document = parse("A long passage for returning to a reading position.");
  const point = { blockId: document.blocks[0].id, offset: 12 };
  const anchor = textAnchor(document, point, point);
  assert.deepEqual(resolveAnchor(document, anchor), anchor);
  assert.equal(resolveAnchor(document, { ...anchor, start: { ...point, offset: 1000 }, end: { ...point, offset: 1000 } }), null);
});

test("the native provider shares retrieval and glossary matching, with precise Unicode offsets", async () => {
  const engine = new DocumentEngine(parse("# Quantum\n\nİstanbul: qubits are quantum bits. A qubit holds information.\n\n## Measurement\n\nMeasurement produces a classical result."));
  const index = await engine.getTextIndex();
  assert.equal(await engine.getTextIndex(), index);
  const matches = findTermMatches(index, "qubit");
  assert.equal(matches.length, 2);
  assert.equal(index.pages[1].text.slice(matches[0].start, matches[0].end), "qubits");
  assert.equal(engine.search("qubits")[0].anchor.kind, "text");
  assert.equal(engine.search("[.*").length, 0);
  assert.equal(engine.search("a", 1).length, 1);
  const chunks = chunkDocument(index);
  const selected = selectAskSources({ chunks, bm25: buildBm25(chunks), question: "What is a qubit?", scope: { kind: "document" } });
  assert.ok(selected.sources.some((source) => source.text.includes("qubits")));
  const source = selected.sources[0];
  assert.ok(resolveAnchor(engine.document, engine.anchorForRange(source.pageNumber, source.start, source.end)));
  assert.deepEqual((await engine.getSections()).map((section) => section.title), ["Quantum", "Measurement"]);
});

test("native sources keep anchors in citation chips, prompts and exact attached occurrences", () => {
  const engine = new DocumentEngine(parse("# Methods\n\nRepeat phrase. Repeat phrase."));
  const anchor = engine.anchorForRange(2, 15, 28);
  const source = { label: "S1", pageNumber: 2, start: 15, end: 28, text: "Repeat phrase", location: anchor, locationLabel: "Methods" };
  assert.equal(sourceChipLabel("stated", [source], String), "Methods");
  assert.match(toChipMarkdown("A claim [S1].", [source], 0, String), /"Methods"/);
  assert.match(renderSources([source], String), /at="Methods"/);
  assert.doesNotMatch(renderSources([source], String), /p="2"/);
  const attached = attachmentSources([{ id: "a", kind: "document", pageNumber: 2, text: source.text, range: [15, 28], location: anchor, locationLabel: "Methods" }], null);
  assert.deepEqual(attached, [{ ...source, label: "" }]);
});
