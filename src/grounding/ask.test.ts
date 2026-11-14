import test from "node:test";
import assert from "node:assert/strict";
import type { TextChunk } from "../text/chunks.ts";
import { ASK_BUDGET, buildAskSystem, selectAskSources, wantsWholeScope, type AskScope } from "./ask.ts";
import { buildBm25, selectRelevant } from "./retrieval.ts";

const document: AskScope = { kind: "document" };
const chunk = (text: string, i: number): TextChunk => ({ id: `p${i + 1}-0`, pageNumber: i + 1, start: 0, end: text.length, text });
const select = (texts: string[], question: string, scope: AskScope = document) => {
  const chunks = texts.map(chunk);
  return selectAskSources({ chunks, bm25: buildBm25(chunks), question, scope });
};

// Paraphrased example of the vocabulary in "The components of agent memory":
// https://www.anthropic.com/research/components-of-agent-memory
// The question's "mechanism" and "LLMs" needn't appear beside "dreaming".
const memoryPaper = [
  "Agent memory persists between sessions as stored notes and searchable records.",
  "Dreaming runs during idle time, reviewing records of earlier sessions and reorganizing stored context.",
  "Dreaming can compare a note with its original transcript and repair errors in that note.",
  "Dreaming can organize linked wiki pages to make information easier to find later.",
  "Dreaming can select a small set of notes to load at the start of the next session.",
  "The memory store is external context; this process does not update trained model weights.",
];

test("the dreaming question receives the whole short paper despite a keyword-search miss", () => {
  const chunks = memoryPaper.map(chunk);
  const bm25 = buildBm25(chunks);
  const question = "What is the mechanism of dreaming in LLMs?";
  assert.deepEqual(selectRelevant(bm25, question, ASK_BUDGET), [], "reproduce the old keyword gate");
  const { sources, basis } = selectAskSources({ chunks, bm25, question, scope: document });
  assert.equal(basis.kind, "scope");
  assert.deepEqual(sources.map((source) => source.text), memoryPaper);
  assert.ok(sources.every((source, i) => source.label === `S${i + 1}` && source.start === 0 && source.end === memoryPaper[i].length));
});

test("a short paper provides complete context for pointed and differently worded questions", () => {
  for (const question of ["What does the offline pass do?", "Why not change the weights?", "How does this work?"]) {
    assert.equal(select(memoryPaper, question).basis.kind, "scope", question);
  }
});

test("a failed search in a medium-sized document falls back to its full text", () => {
  const texts = Array.from({ length: 150 }, () => "Background material about persistent records. ".repeat(10));
  const { sources, basis } = select(texts, "What is the proposed architecture?");
  assert.equal(basis.kind, "scope");
  assert.equal(sources.length, texts.length);
});

test("automatic widening finds a concept even when unmatched query terms swamp its score", () => {
  const texts = Array.from({ length: 500 }, (_, i) =>
    (i % 2 ? "Dreaming reviews transcripts to repair stored notes. " : "Background material describes persistent records. ").repeat(12),
  );
  const chunks = texts.map(chunk);
  const bm25 = buildBm25(chunks);
  const question = "What is the mechanism of dreaming in LLMs?";
  assert.deepEqual(selectRelevant(bm25, question, ASK_BUDGET), []);
  for (const wider of [false, true]) {
    const { sources, basis } = selectAskSources({ chunks, bm25, question, scope: document, wider });
    assert.equal(basis.kind, "passages");
    assert.ok(sources.length > 0);
    assert.ok(sources.every((source) => /Dreaming/.test(source.text)));
    assert.ok(sources.reduce((sum, source) => sum + source.text.length, 0) <= ASK_BUDGET.ceilingChars);
  }
});

test("long-document overviews include the beginning, middle and end within their budget", () => {
  const texts = Array.from({ length: 500 }, (_, i) => `Part ${i}: ${"Background information. ".repeat(28)}`);
  texts[499] = `Conclusion: ${"Limits and future directions. ".repeat(20)}`;
  for (const question of ["Summarize this paper", "What is the proposed architecture?"]) {
    const { sources, basis } = select(texts, question);
    assert.deepEqual(basis, { kind: "partial", count: sources.length, sampled: true });
    assert.ok(sources.some((source) => source.pageNumber === 1));
    assert.ok(sources.some((source) => source.pageNumber === 250 || source.pageNumber === 251));
    assert.ok(sources.some((source) => source.pageNumber === 500));
    assert.ok(sources.reduce((sum, source) => sum + source.text.length, 0) <= ASK_BUDGET.overviewChars);
    assert.equal(new Set(sources.map((source) => source.chunkId)).size, sources.length);
  }
});

test("full-text fallbacks respect the scope the reader explicitly requested", () => {
  const texts = ["Outside the section.", ...memoryPaper, "Also outside the section."];
  const scope: AskScope = { kind: "section", title: "Memory", from: 2, to: 7 };
  const { sources, basis } = select(texts, "What is the mechanism of dreaming in LLMs?", scope);
  assert.equal(basis.kind, "scope");
  assert.deepEqual(sources.map((source) => source.text), memoryPaper);
});

test("only an empty scope has no sources", () => {
  assert.deepEqual(select([], "Explain this paper"), { sources: [], basis: { kind: "none" } });
  assert.deepEqual(select(memoryPaper, "Explain this page", { kind: "page", page: 99 }), { sources: [], basis: { kind: "none" } });
});

test("common paper-wide questions are recognized beyond explicit summary wording", () => {
  for (const question of ["Explain this paper", "Walk me through the article", "What problem does this paper address?", "What are the limitations of this study?"]) {
    assert.ok(wantsWholeScope(question), question);
  }
});

test("Ask prompts support synthesis and distinguish partial evidence from absence", () => {
  const { sources } = select(memoryPaper, "What is dreaming?");
  const system = buildAskSystem({ fileName: "memory.pdf", scope: document, sources, basis: { kind: "partial", count: sources.length, sampled: true }, generalAllowed: false, pageLabel: String });
  assert.match(system, /different words from the author/);
  assert.match(system, /Answer the supported part/);
  assert.match(system, /not the complete text/);
  assert.match(system, /rather than asserting the document doesn't cover it/);
});
