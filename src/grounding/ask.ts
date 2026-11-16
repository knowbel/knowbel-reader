import type { TextChunk } from "../text/chunks.ts";
import { overlapsAny } from "./attachments.ts";
import { labelSources } from "./context.ts";
import { MATH_RULES, SOURCE_RULES, renderSources } from "./prompt.ts";
import { selectRelevant, type Bm25Index } from "./retrieval.ts";
import type { SourceRef } from "./types.ts";

// Short papers are read in full. Longer documents use retrieval, with a
// bounded overview when word overlap alone can't find an answer. A search
// miss is not evidence that the document doesn't discuss something.

export type AskScope =
  | { kind: "document" }
  | { kind: "section"; title: string; from: number; to: number }
  | { kind: "page"; page: number };

// What an answer rests on, shown under it: "Based on 4 passages" /
// "Based on all of Chapter 3" / "Based on part of the document".
export type AskBasis =
  | { kind: "passages"; count: number }
  | { kind: "scope" }
  | { kind: "partial"; count: number; sampled?: boolean }
  | { kind: "none" };

export const ASK_BUDGET = { wholeScopeChars: 60_000, overviewChars: 40_000, typicalChars: 8000, ceilingChars: 200_000 };
// "Search wider": more passages, including less clearly relevant ones.
export const ASK_WIDER = { typicalChars: 24_000, ceilingChars: 200_000, relativeCutoff: 0.2, minFraction: 0 };
// When the clearly relevant passages already make up this much of the scope,
// sending all of it costs little more and reads better.
const WHOLE_SCOPE_SHARE = 0.6;

export function inScope(chunk: TextChunk, scope: AskScope): boolean {
  if (scope.kind === "document") return true;
  if (scope.kind === "page") return chunk.pageNumber === scope.page;
  return chunk.pageNumber >= scope.from && chunk.pageNumber <= scope.to;
}

export function scopeLabel(scope: AskScope, pageLabel: (pageNumber: number) => string): string {
  if (scope.kind === "document") return "the whole document";
  if (scope.kind === "page") return `p. ${pageLabel(scope.page)}`;
  return scope.title;
}

// Questions about a scope as a whole — its argument, a summary, everything of
// some kind in it — rather than about something in it.
const WHOLE_SCOPE_QUESTION =
  /\b(summari[sz]e|summary|overview|outline|gist|tl;?dr|big picture|main (?:idea|point|argument|claim|theme|takeaway|contribution|result)s?|key (?:idea|point|takeaway|concept|result)s?|what(?:'s| is| are) (?:this|the) (?:chapter|section|paper|document|book|article|text|page)(?:'s)? (?:about|saying|arguing)|what does (?:this|the) (?:chapter|section|paper|document|book|article|text|page) (?:say|cover|argue|discuss)|(?:list|name) (?:all|every|each)|all the (?:theorems|definitions|lemmas|examples|exercises|equations|figures|claims|results|terms)|structure of (?:this|the))\b/i;

export function wantsWholeScope(question: string): boolean {
  return WHOLE_SCOPE_QUESTION.test(question) ||
    /\b(?:explain|describe|understand|walk me through|tell me about)\s+(?:this|the)\s+(?:paper|article|document|chapter|section|book)\b/i.test(question) ||
    /\b(?:what|which)\s+(?:problem|question|challenge)s?\s+(?:does|is|are)\s+(?:this|the)\s+(?:paper|article|work|study)\b/i.test(question) ||
    /\b(?:motivation|contributions?|limitations?|findings?|novelty)\s+(?:of|in|behind)\s+(?:this|the)\s+(?:paper|article|work|study)\b/i.test(question);
}

// A follow-up that leans on the previous question ("why?", "how does it
// work?", "give an example") — searched together with it. Anything else is
// searched on its own, so an unrelated question isn't answered from the last
// one's passages.
const FOLLOW_UP = /\b(it|its|this|that|these|those|they|them|their|why|how so|more|example|elaborate|explain|else|also)\b/i;

export function isFollowUp(question: string): boolean {
  return FOLLOW_UP.test(question);
}

export interface AskSelection {
  sources: SourceRef[];
  basis: AskBasis;
  // Lets a bare follow-up keep its previous evidence instead of replacing
  // it with an overview when neither wording can be found again.
  retrievalMiss?: boolean;
}

// Keep the opening, ending, query hits and excerpts spread across a scope.
// Taking only its first few chunks misses conclusions and later chapters.
// Whole chunks preserve exact citation offsets; oversized ones are skipped.
function overviewChunks(scoped: TextChunk[], relevant: TextChunk[]): TextChunk[] {
  const chosen = new Map<string, TextChunk>();
  let size = 0;
  const add = (chunk: TextChunk) => {
    if (chosen.has(chunk.id) || size + chunk.text.length > ASK_BUDGET.overviewChars) return;
    chosen.set(chunk.id, chunk);
    size += chunk.text.length;
  };
  scoped.slice(0, 4).forEach(add);
  scoped.slice(-4).forEach(add);
  for (const chunk of relevant) {
    if (size + chunk.text.length > ASK_BUDGET.overviewChars / 2) break;
    add(chunk);
  }
  // Bisect successively so every part gets a chance before filling gaps.
  for (let divisions = 2; divisions < scoped.length * 2; divisions *= 2) {
    for (let i = 1; i < divisions; i += 2) add(scoped[Math.floor(i * scoped.length / divisions)]);
  }
  return [...chosen.values()];
}

export function selectAskSources(params: {
  chunks: TextChunk[];
  bm25: Bm25Index;
  question: string;
  previousQuestion?: string; // gives a follow-up ("why?") something to search with
  scope: AskScope;
  wider?: boolean;
  // Passages the reader added to the question: always sent, and their text
  // helps find related passages elsewhere.
  attached?: SourceRef[];
  extraQuery?: string;
}): AskSelection {
  const { chunks, bm25, question, previousQuestion, scope, wider, attached = [], extraQuery = "" } = params;
  const scoped = chunks.filter((chunk) => inScope(chunk, scope));
  const scopeChars = scoped.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const toSources = (list: TextChunk[]) =>
    labelSources([
      ...attached,
      ...list
        .map((chunk) => ({
          label: "",
          pageNumber: chunk.pageNumber,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
          chunkId: chunk.id,
        }))
        .filter((source) => !overlapsAny(source, attached)),
    ]);
  const whole = (): AskSelection => ({ sources: toSources(scoped), basis: { kind: "scope" } });

  if (scoped.length === 0) {
    return attached.length ? { sources: toSources([]), basis: { kind: "passages", count: attached.length } } : { sources: [], basis: { kind: "none" } };
  }
  if (scopeChars <= ASK_BUDGET.wholeScopeChars ||
      (wantsWholeScope(question) && scopeChars <= ASK_BUDGET.ceilingChars)) return whole();

  // Out of scope, or already sent as an attached passage — excluded before
  // ranking, so an attached passage's own chunk doesn't set the bar for
  // what else counts as relevant.
  const outOfScope = new Set(
    chunks
      .filter((chunk) => !inScope(chunk, scope) || overlapsAny({ ...chunk, label: "" }, attached))
      .map((chunk) => chunk.id),
  );
  const budget = wider ? ASK_WIDER : ASK_BUDGET;
  let searchText = `${question} ${extraQuery}`.trim();
  let relevant = selectRelevant(bm25, searchText, { ...budget, exclude: outOfScope });
  if (relevant.length === 0 && previousQuestion && FOLLOW_UP.test(question)) {
    searchText = `${previousQuestion} ${searchText}`;
    relevant = selectRelevant(bm25, searchText, { ...budget, exclude: outOfScope });
  }
  // A question can contain vocabulary absent from the text ("mechanism",
  // "LLMs") alongside the exact concept it discusses ("dreaming"). Don't
  // let those unmatched words prevent the model from seeing that concept.
  if (relevant.length === 0 && !wider) {
    relevant = selectRelevant(bm25, searchText, { ...ASK_WIDER, exclude: outOfScope });
  }

  // A whole-scope question over more text than the ceiling allows: the most
  // relevant part of it, said so.
  if (wantsWholeScope(question)) {
    const sources = toSources(overviewChunks(scoped, relevant.map((r) => r.chunk)));
    return { sources, basis: { kind: "partial", count: sources.length, sampled: true } };
  }
  if (relevant.length === 0 && attached.length === 0) {
    if (scopeChars <= ASK_BUDGET.ceilingChars) return { ...whole(), retrievalMiss: true };
    const sources = toSources(overviewChunks(scoped, []));
    return { sources, basis: { kind: "partial", count: sources.length, sampled: true }, retrievalMiss: true };
  }

  const chosenChars = relevant.reduce((sum, r) => sum + r.chunk.text.length, 0);
  if (relevant.length && chosenChars >= WHOLE_SCOPE_SHARE * scopeChars && scopeChars <= ASK_BUDGET.ceilingChars) return whole();
  const sources = toSources(relevant.map((r) => r.chunk));
  return { sources, basis: { kind: "passages", count: sources.length } };
}

const ASK_ANSWER_RULES = `How to answer:
- Start with a direct answer in plain language, then give a self-contained explanation. Choose the length and depth to fit the question and the reader's requested level of detail. Make the answer useful without requiring a follow-up. No preamble, repetition, or unnecessary recap.
- When asked what a term or passage means, define it in simpler words and explain what it refers to in this document. Unpack the process or relationship behind the wording rather than repeating the term or quoting the passage as its own explanation.
- Include the mechanism, reasoning, or context needed to understand the answer. Add a concrete example or analogy when it clarifies the idea, clearly distinguishing illustrations from claims made by the document.
- Keep the explanation focused. Use short paragraphs, bullets for distinct points, or numbered steps for a process or derivation when they improve readability.
${SOURCE_RULES}`;

export function buildAskSystem(params: {
  fileName: string;
  scope: AskScope;
  basis: AskBasis;
  sources: SourceRef[];
  generalAllowed: boolean;
  pageLabel: (pageNumber: number) => string;
  // What the reader added to this question (grounding/attachments.ts) —
  // last, since it changes with every question while the rest can stay a
  // cacheable prefix.
  attachmentNote?: string;
}): string {
  const { fileName, scope, basis, sources, generalAllowed, pageLabel, attachmentNote } = params;
  const where = scope.kind === "document" ? "" : ` The reader is asking about ${scopeLabel(scope, pageLabel)}.`;
  const partial =
    basis.kind === "partial" || basis.kind === "passages"
      ? " You have selected excerpts, not the complete text. Explain what they support, and say when the rest would be needed; don't claim the whole document lacks an answer."
      : "";
  const general = generalAllowed
    ? "\n- The reader asked for an answer even where the document doesn't cover it: answer from general knowledge there, marking those claims [general]. Don't reply [not-covered]."
    : "";
  // Sources first and fixed across a thread's follow-ups, so a large context
  // is a stable prefix the provider can serve from its prompt cache.
  return `You help a reader study a document titled "${fileName}". Answer their question using these passages from it.${where}${partial}

Sources from the document:
${sources.length ? renderSources(sources, pageLabel) : "(no readable document passages available)"}

${ASK_ANSWER_RULES}${general}

For this question:
- Interpret the reader's terminology in the context of the document. A concept can be explained even when the reader uses different words from the author.
- Synthesize an explanation from multiple passages when useful. Answer the supported part of a question even if some details are missing; identify those gaps and mark reasoned connections [inferred: S1] with the actual source id.
${generalAllowed ? "- Where evidence is missing, use general knowledge as requested, marked [general]." : "- Use [not-covered] only when the supplied evidence cannot support even a partial answer. If you only have excerpts, say you couldn't find an answer in those excerpts rather than asserting the document doesn't cover it."}

${MATH_RULES}${attachmentNote ? `\n\n${attachmentNote}` : ""}`;
}
