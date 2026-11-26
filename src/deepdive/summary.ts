import { citedSources } from "../grounding/citations.ts";
import { labelSources } from "../grounding/context.ts";
import { renderSources } from "../grounding/prompt.ts";
import type { SourceRef } from "../grounding/types.ts";
import { DISCOVER_QUESTIONS, NO_GUIDE_ORIENTATION } from "./guided.ts";
import { openingMessage } from "./prompts.ts";
import { treeOf } from "./tree.ts";
import type { DivePanel, DiveTurn } from "./types.ts";

// A one-page summary of everything explored from one passage (the
// treeSummary experiment): the questions asked across the whole dive tree,
// the key terms and notation, tied back to the passage it started from.
// Every answer's citations are renumbered into one shared source list, so
// the summary cites pages like any other answer.

const ANSWER_CHARS = 1500;
const TRANSCRIPT_CHARS = 40_000;
const MAX_SOURCES = 30;

const sourceKey = (source: SourceRef) => source.chunkId ?? `${source.pageNumber}:${source.start}`;

// [S3] · [S3, S7] · [inferred: S3] — as in grounding/citations.ts.
const MARKER = /\[\s*(inferred\s*:?\s*)?(S\d+(?:\s*,\s*S\d+)*)\s*\]/gi;

function isCompletedAnswer(turn: DiveTurn): boolean {
  return turn.role === "assistant" && !turn.status && Boolean(turn.content.trim()) && !turn.content.startsWith("⚠️");
}

function isDiscoveryQuestion(panel: DivePanel, turn?: DiveTurn): boolean {
  return panel.guided === "guide" && turn?.role === "user" && turn.content === DISCOVER_QUESTIONS;
}

// An answer's markers rewritten from its own request's ids to the shared
// ones; ids with no shared counterpart are dropped.
function relabel(text: string, own: SourceRef[], shared: Map<string, string>): string {
  const byLabel = new Map(own.map((source) => [source.label.toUpperCase(), source]));
  return text.replace(MARKER, (_match, inferred: string | undefined, ids: string) => {
    const mapped = ids
      .split(",")
      .map((id) => byLabel.get(id.trim().toUpperCase()))
      .map((source) => (source ? shared.get(sourceKey(source)) : undefined))
      .filter((label): label is string => Boolean(label));
    if (mapped.length === 0) return "";
    return inferred ? `[inferred: ${mapped.join(", ")}]` : `[${mapped.join(", ")}]`;
  });
}

// Answers in the tree (errors aside): how a stored summary knows it's out of
// date.
export function treeAnswerCount(panels: DivePanel[], rootId: string): number {
  return treeOf(panels, rootId).reduce(
    (sum, { panel }) => sum + panel.turns.filter((turn, index) =>
      isCompletedAnswer(turn) && !isDiscoveryQuestion(panel, panel.turns[index - 1])).length,
    0,
  );
}

// A stable description of the inputs, so edits and deleted branches also
// invalidate a summary even when the number of answers is unchanged.
export function treeRevision(panels: DivePanel[], rootId: string): string {
  const data = JSON.stringify(treeOf(panels, rootId).map(({ panel }) => ({
    id: panel.id, parentId: panel.parentId, selection: panel.selection,
    turns: panel.turns.filter((turn) => !turn.status && !turn.content.startsWith("⚠️")).map(({ role, content, sources }) => ({ role, content, sources })),
  })));
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
  return `v1-${(hash >>> 0).toString(16)}-${data.length}`;
}

export function buildTreeSummaryRequest(params: {
  fileName: string;
  panels: DivePanel[];
  rootId: string;
  pageLabel: (pageNumber: number) => string;
}): { system: string; prompt: string; sources: SourceRef[] } {
  const tree = treeOf(params.panels, params.rootId);
  const root = tree[0]?.panel;

  // The shared sources: every passage an answer cited, root first.
  const collected = new Map<string, SourceRef>();
  for (const { panel } of tree) {
    for (const turn of panel.turns) {
      if (!isCompletedAnswer(turn) || !turn.sources) continue;
      for (const source of citedSources(turn.content, turn.sources)) {
        if (collected.size >= MAX_SOURCES) break;
        if (!collected.has(sourceKey(source))) collected.set(sourceKey(source), source);
      }
    }
  }
  const sources = labelSources([...collected.values()].map((source) => ({ ...source })));
  const shared = new Map(sources.map((source) => [sourceKey(source), source.label]));

  // The transcript, dive by dive.
  const parts: string[] = [];
  let length = 0;
  const unexplored: string[] = [];
  for (const { panel, depth } of tree) {
    const title = depth === 0 ? "The passage the reader started from" : `A deeper dive (level ${depth}) into`;
    const lines = [`## ${title}: "${panel.selection || "(a selected region of the page)"}"`];
    panel.turns.forEach((turn, index) => {
      if (turn.role === "user") {
        const answer = panel.turns[index + 1];
        if (!answer || !isCompletedAnswer(answer) || isDiscoveryQuestion(panel, turn)) return;
        if (index === 0 && turn.content === openingMessage(panel.selection)) return;
        lines.push(`Reader: ${turn.content}`);
      } else if (isCompletedAnswer(turn)) {
        const orientation = isDiscoveryQuestion(panel, panel.turns[index - 1]);
        if (orientation && turn.content === NO_GUIDE_ORIENTATION) return;
        const text = relabel(turn.content, turn.sources ?? [], shared);
        lines.push(`${orientation ? "Passage orientation" : "Answer"}: ${text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS)}…` : text}`);
      }
    });
    if (root?.guided === "guide" && depth > 0 && lines.length === 1) continue;
    const block = lines.join("\n\n");
    if (length + block.length > TRANSCRIPT_CHARS) {
      parts.push("Some later branches were omitted because the exploration is long. Summarize only the material included here.");
      break;
    }
    parts.push(block);
    length += block.length;

    // Suggestions on the dive's latest answer that nobody followed.
    const last = [...panel.turns].reverse().find((turn) => turn.role === "assistant");
    const children = new Set(
      params.panels.filter((p) => p.parentId === panel.id).map((p) => p.selection.trim().toLowerCase()),
    );
    const asked = new Set(panel.turns.filter((turn) => turn.role === "user").map((turn) => turn.content.trim().toLowerCase()));
    for (const suggestion of last?.suggestions ?? []) {
      const key = suggestion.text.trim().toLowerCase();
      if (suggestion.kind === "diagram" || children.has(key) || asked.has(key)) continue;
      unexplored.push(suggestion.text);
    }
  }
  if (unexplored.length) parts.push(`## Suggested but not explored\n${unexplored.slice(0, 6).map((text) => `- ${text}`).join("\n")}`);

  const system = `You write a study summary of a reader's deep dive into a passage of a PDF titled "${params.fileName}": everything they explored, tied back to the passage they started from${
    root?.selection ? ` ("${root.selection.slice(0, 300)}")` : ""
  }. Keep what helps them understand that passage; drop repetition and anything they didn't need. Earlier assistant answers are context, not evidence. Support claims with the supplied document passages, and acknowledge when they do not establish an answer.

Format, in markdown:
**In short:** one to three sentences on what the passage means and why it matters, in plain words.

## Questions explored
- **A question they explored, in their words?** Two or three sentences of answer.
(Only questions actually explored; merge overlapping ones; order them so each builds on the last.)

## Key terms and notation
- **term, or $symbol$**: its meaning here.

## Still open
- Questions the reader asked that the supplied sources did not resolve. Only if there are any; otherwise leave this section out.

## Suggested next steps
- Directions suggested but not explored. Only if the transcript lists some; otherwise leave this section out.

Length: at most a page (about 350 words), and shorter when the dive was short.

After each claim taken from a source, cite it by id: [S2]. For something reasoned from the sources: [inferred: S2]. For outside knowledge: [general]. Never cite an id that isn't listed below.

Use $...$ for inline KaTeX math, including in headings and bold questions, and $$...$$ for display equations. Reconstruct a formula only when its notation is clear from the sources; otherwise acknowledge the uncertainty.

Sources from the document:
${renderSources(sources, params.pageLabel)}`;

  return { system, prompt: parts.join("\n\n"), sources };
}
