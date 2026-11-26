import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";
import type { Root } from "hast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { rehypeAnnotate } from "./annotate.ts";
import { buildDivePrompt } from "./prompts.ts";
import { appendTurn, createRootPanel } from "./tree.ts";
import { createGuidedQuestion, DISCOVER_QUESTIONS, EXPLANATION_SEPARATOR, forDiveRequest, guideDiscovery, guidedReply, guidedRoot, guidedShortAnswer, NO_GUIDE_ORIENTATION, questionAnswer, readGuideOrientation, streamingGuidedAnswer } from "./guided.ts";
import { inlineMathParts, normalizeMathNotation } from "./mathNotation.ts";
import type { DivePanel } from "./types.ts";
import type { SourceRef } from "../grounding/types.ts";

const guide: DivePanel = {
  ...createRootPanel({ anchorHighlightId: "mark", selection: "Fish deaths peaked after the bloom.", contextText: "Bacteria used up oxygen." }),
  guided: "guide",
};
const source: SourceRef = { label: "S1", pageNumber: 4, start: 0, end: 21, text: "Bacteria used oxygen." };
const pageLabel = (number: number) => String(number);

test("discovery reads the selection and captures only distinct ranked questions", () => {
  const system = buildDivePrompt("Lakes", guide, null).system;
  assert.match(system, /Fish deaths peaked after the bloom/);
  assert.match(system, /Bacteria used up oxygen/);
  const reply = guidedReply(guide, "<next>\nask: Why did deaths peak later? [S1]\nask: Why did deaths peak later?\ndive: Oxygen\nask: What changed when the bloom faded?\n</next>");
  assert.deepEqual(reply.suggestions.map(({ text }) => text), [
    "Why did deaths peak later?", "What changed when the bloom faded?",
  ]);
  assert.equal(forDiveRequest(guide, DISCOVER_QUESTIONS).guided, "guide");
  assert.equal(forDiveRequest(guide, "An ordinary question").guided, undefined);
  assert.equal(guide.guided, "guide");
});

test("the same discovery reply can carry a brief grounded orientation and suggested questions", () => {
  const prompt = buildDivePrompt("Lakes", guide, null, { sources: [source], pageLabel }).system;
  assert.match(prompt, /<orientation>/);
  assert.match(prompt, /The orientation is optional/);
  const orientation = "The author is connecting the bloom's aftermath to a drop in oxygen. [S1]";
  const opening = `<orientation>\n${orientation}\n</orientation>`;
  const questions = "<next>\nask: Why did the deaths peak later?\n</next>";
  assert.equal(readGuideOrientation(opening + "\n<ne"), orientation);
  assert.equal(readGuideOrientation(opening.slice(0, -5)), "");
  const reply = guidedReply(guide, opening + "\n" + questions);
  assert.equal(reply.body, orientation);
  assert.equal(reply.suggestions[0]?.text, "Why did the deaths peak later?");
  assert.equal(guidedReply(guide, questions).body, NO_GUIDE_ORIENTATION);
  assert.equal(guidedReply(guide, "<orientation>" + "A".repeat(421) + "</orientation>\n" + questions).body, NO_GUIDE_ORIENTATION);

  const discovery = appendTurn(guide, "user", DISCOVER_QUESTIONS);
  const saved = appendTurn(discovery, "assistant", reply.body, { sources: [source] });
  const followedUp = appendTurn(appendTurn(saved, "user", "What about temperature?"), "assistant", "A separate answer.");
  assert.equal(guideDiscovery(followedUp).orientation, orientation);
  assert.deepEqual(guideDiscovery(followedUp).reply?.sources, [source]);
  assert.equal(guideDiscovery(appendTurn(discovery, "assistant", NO_GUIDE_ORIENTATION)).orientation, "");
  assert.equal(guideDiscovery(appendTurn(discovery, "assistant", "Failed", { status: "error" })).orientation, "");
});

test("a recursive reply is grounded in the original passage and the visible parent answer", () => {
  const first = createGuidedQuestion(guide, { parentId: guide.id, question: "Why did it happen later?", attachments: [] }, pageLabel);
  const original = appendTurn(appendTurn(first, "user", first.selection), "assistant", "Decomposition depleted dissolved oxygen. [S1]", { sources: [source] });
  const simplified = appendTurn(appendTurn(original, "user", "Simplify", { simplify: true }), "assistant", "The bacteria used up oxygen. [S1]", { sources: [source] });
  const { original: originalIndex, simpler } = questionAnswer(simplified);
  assert.equal(originalIndex, 1);
  assert.equal(simpler, 3);
  const child = createGuidedQuestion(simplified, { parentId: first.id, question: "How do we know?", answerTurnIndex: simpler, attachments: [] }, pageLabel);
  assert.equal(guidedRoot([guide, simplified, child], child.id)?.id, guide.id);
  assert.deepEqual(child.inheritedSources, [source]);
  const system = buildDivePrompt("Lakes", child, simplified, { sources: [source], pageLabel }, { root: { selection: guide.selection } }).system;
  assert.match(system, /The bacteria used up oxygen/);
  assert.match(system, /Fish deaths peaked after the bloom/);
  assert.doesNotMatch(system, /Decomposition depleted dissolved oxygen/);
  assert.match(system, /After the complete answer.*up to 2 distinct follow-up questions/);
  const reply = guidedReply(child, "An answer.\n<next>\nask: How do we know?\nask: Why?\nask: Why?\ndive: Oxygen\nask: Where?\n</next>");
  assert.equal(reply.body, "An answer.");
  assert.deepEqual(reply.suggestions.map(({ text }) => text), ["Why?", "Where?"]);
});

test("an interrupted simplification leaves the original answer available", () => {
  const child = createGuidedQuestion(guide, { parentId: guide.id, question: "Why?", attachments: [] }, pageLabel);
  const original = appendTurn(appendTurn(child, "user", "Why?"), "assistant", "Original answer");
  const stopped = appendTurn(appendTurn(original, "user", "Simplify", { simplify: true }), "assistant", "Stopped", { status: "cancelled" });
  assert.deepEqual(questionAnswer(stopped), { original: 1, simpler: -1 });
});

test("a guided question saves a single cited answer with a complete equation in its short opening", () => {
  const child = createGuidedQuestion(guide, { parentId: guide.id, question: "What is the joint state?", attachments: [] }, pageLabel);
  const { system } = buildDivePrompt("States", child, guide, { sources: [source], pageLabel });
  assert.ok(system.includes(EXPLANATION_SEPARATOR));
  const lead = "The joint state is the tensor product of the individual states:\n\n$$\n\\rho_{AB}=\\rho_A\\otimes\\rho_B\n$$\n\n[S1]";
  const detail = "Independent preparation is the assumption behind this formula. [S1]";
  const raw = [lead, EXPLANATION_SEPARATOR, detail, "<next>\nask: What if they are correlated?\n</next>"].join("\n\n");
  const reply = guidedReply(child, raw);
  const panel = appendTurn(child, "assistant", reply.body, { shortAnswerEnd: reply.shortAnswerEnd, suggestions: reply.suggestions, sources: [source] });
  const turn = panel.turns[0];
  assert.equal(turn.content, lead + "\n\n" + detail);
  assert.equal(guidedShortAnswer(turn), lead);
  assert.deepEqual(turn.sources, [source]);
  assert.equal(turn.suggestions?.[0]?.text, "What if they are correlated?");
});

test("the short answer is available as soon as its separator arrives, even across stream chunks", () => {
  const lead = "Reading the definition supplies the missing assumption.";
  const prefix = lead + "\r\n\r\n";
  for (let n = 1; n < EXPLANATION_SEPARATOR.length; n++) {
    const partial = streamingGuidedAnswer(prefix + EXPLANATION_SEPARATOR.slice(0, n));
    assert.equal(partial.content.trimEnd(), lead);
    assert.equal(partial.shortAnswerEnd, undefined);
  }
  const short = streamingGuidedAnswer(prefix + EXPLANATION_SEPARATOR);
  assert.deepEqual(short, { content: lead, shortAnswerEnd: lead.length });
  assert.equal(guidedShortAnswer(short), lead);
  const full = streamingGuidedAnswer(prefix + EXPLANATION_SEPARATOR + "\r\n\r\nMore detail.\n\n<ne");
  assert.equal(full.content.trimEnd(), lead + "\n\nMore detail.");
  assert.equal(guidedShortAnswer(full), lead);
  assert.equal(streamingGuidedAnswer(prefix + EXPLANATION_SEPARATOR + "\n\nDetail.\n\n<next>\nask: Why?").content.trimEnd(), lead + "\n\nDetail.");
});

test("old answers and malformed short answers are shown whole or left for the thread", () => {
  const content = "A compact answer with two complete paragraphs.\n\nThis is the second paragraph.";
  assert.equal(guidedShortAnswer({ content }), content);
  assert.equal(guidedShortAnswer({ content: content.repeat(8) }), "");
  const dangling = "The joint state is: [S1]";
  assert.equal(guidedShortAnswer({ content: dangling + "\n\nAn equation goes here.", shortAnswerEnd: dangling.length }), "");
  const child = createGuidedQuestion(guide, { parentId: guide.id, question: "Why?", attachments: [] }, pageLabel);
  assert.equal(guidedReply(child, EXPLANATION_SEPARATOR + "\n\n" + content).body, content);
  assert.equal(guidedReply(child, content + "\n\n" + EXPLANATION_SEPARATOR).shortAnswerEnd, content.length);
});

test("an occurrence in the explanation never moves to the short answer", () => {
  const target = { id: "detail", kind: "highlight" as const, text: "oxygen", turnIndex: 1, occurrence: 1 };
  const preview: Root = { type: "root", children: [{ type: "text", value: "Bacteria used oxygen." }] };
  const answer: Root = { type: "root", children: [{ type: "text", value: "Bacteria used oxygen. The oxygen had been dissolved in the water." }] };
  const annotate = rehypeAnnotate({ turnIndex: 1, targets: [target], claims: new Map(), strictOccurrence: true });
  annotate(preview);
  annotate(answer);
  assert.equal(preview.children.length, 1);
  assert.deepEqual(answer.children[0], { type: "text", value: "Bacteria used oxygen. The " });
  assert.equal(answer.children[1]?.type, "element");
});

test("guided questions accept inline LaTeX even when command names exceed the plain-text budget", () => {
  const question = String.raw`What are $W$ and $V$ for $U\lvert\psi\rangle\lvert0\rangle = \sum_m M_m\lvert\psi\rangle\lvert m\rangle$?`;
  assert.ok(question.length > 100);
  const prompt = buildDivePrompt("States", guide, null).system;
  assert.ok(prompt.includes("question labels as inline $...$ KaTeX"));
  assert.equal(guidedReply(guide, `<next>\nask: ${question}\n</next>`).suggestions[0]?.text, question);
  assert.deepEqual(inlineMathParts(question).flatMap((part) => part.tex ? [part.tex] : []), [
    "W", "V", String.raw`U\lvert\psi\rangle\lvert0\rangle = \sum_m M_m\lvert\psi\rangle\lvert m\rangle`,
  ]);
});

test("plain saved labels and PDF excerpts render recognizable notation without changing the source text", () => {
  const text = "What are W and V for U|ψ>|o> = sum M_m|ψ>|m>? In W -> V, U † is an adjoint.";
  const parts = inlineMathParts(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(parts.flatMap((part) => part.tex ? [part.tex] : []), [
    String.raw`U|\psi\rangle`, String.raw`|o\rangle`, String.raw`\sum`, "M_{m}",
    String.raw`|\psi\rangle`, String.raw`|m\rangle`, String.raw`W \to V`, String.raw`U^{\dagger}`,
  ]);
  const prose = "I’m reading section 2.67 and comparing prices of $5 and $10 with `M_m`.";
  assert.equal(inlineMathParts(prose).map((part) => part.tex ?? part.text).join(""), prose);
});

test("KaTeX renders PDF matrix elements, overlaps, and standalone bras without merging control sequences", () => {
  const excerpt = "⟨w1|U †U |w2⟩ = ⟨w1|w2⟩, where ⟨w1| is a bra.";
  const parts = inlineMathParts(excerpt);
  assert.equal(parts.map(({ text }) => text).join(""), excerpt);
  const expressions = parts.flatMap(({ tex }) => tex ? [tex] : []);
  assert.deepEqual(expressions, [
    String.raw`\langle w1 \lvert U^{\dagger}U \rvert w2\rangle`,
    String.raw`\langle w1 \mid w2\rangle`,
    String.raw`\langle w1|`,
  ]);
  for (const expression of expressions) {
    assert.doesNotThrow(() => katex.renderToString(expression, { throwOnError: true }));
  }
  const [, answerMath] = normalizeMathNotation("The overlap is ⟨w1|w2⟩.").split("$$");
  assert.match(answerMath, /\\langle w1/);
  assert.doesNotThrow(() => katex.renderToString(answerMath, { throwOnError: true }));
});

test("comma-separated infix fractions render as individual fractions in answers", () => {
  const formula = String.raw`|00\rangle+|11\rangle\over \sqrt 2,\quad |00\rangle-|11\rangle\over \sqrt 2,\quad |10\rangle+|01\rangle\over \sqrt 2,\quad |01\rangle-|10\rangle\over \sqrt 2`;
  const parser = unified().use(remarkParse).use(remarkMath);
  for (const raw of [formula, `$$\n${formula}\n$$`]) {
    const markdown = normalizeMathNotation(`The states are:\n\n${raw}\n\nEach has norm one.`);
    const nodes = parser.parse(markdown).children;
    assert.deepEqual(nodes.map(({ type }) => type), ["paragraph", "math", "paragraph"]);
    const equation = nodes[1];
    assert.equal(equation.type, "math");
    const html = katex.renderToString(equation.value, { throwOnError: true, output: "mathml" });
    assert.equal([...html.matchAll(/<mfrac>/g)].length, 4);
  }
  const inline = String.raw`$\langle f(a,b)\rangle\over x$`;
  assert.equal(normalizeMathNotation(inline), inline);
  const matrix = String.raw`$\begin{matrix} a\over b, & c\over d \end{matrix}$`;
  assert.equal(normalizeMathNotation(matrix), matrix);
  const grouped = String.raw`$\text{one, two}\over x, \quad a\over b$`;
  const normalized = normalizeMathNotation(grouped);
  assert.equal(normalized, "$" + String.raw`{\text{one, two}\over x}, \quad {a\over b}$`);
  const code = "```tex\n" + formula + "\n" + grouped + "\n```";
  assert.equal(normalizeMathNotation(code), code);
});
