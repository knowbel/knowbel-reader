import type { Attachment } from "../grounding/attachments.ts";
import { citedSources, markersToPages } from "../grounding/citations.ts";
import { splitDiagram } from "./diagram.ts";
import { createNestedPanel, rootPanelOf } from "./tree.ts";
import { hideSuggestionBlock, mergeSuggestions, splitSuggestions } from "./suggestions.ts";
import type { DivePanel, DiveTurn } from "./types.ts";

export const DISCOVER_QUESTIONS = "What might be confusing about this selection in context?";
export const NO_GUIDE_ORIENTATION = "Choose a question to explore.";
export const SIMPLIFY_ANSWER = "Explain your answer more simply. Use familiar words or a small example, and keep the important assumptions.";
export const MAX_GUIDED_FOLLOW_UPS = 2;
export const EXPLANATION_SEPARATOR = "<!-- dive-explanation -->";
const SEPARATOR_LINE = /^[ \t]*<!--[ \t]*dive-explanation[ \t]*-->[ \t]*\r?$/im;

interface GuidedAnswer {
  content: string;
  shortAnswerEnd?: number;
}

// Store the full answer once. The overview reads a prefix of that same
// markdown so citations, answer versions, and highlight anchors stay aligned.
function splitGuidedAnswer(content: string): GuidedAnswer {
  const boundary = SEPARATOR_LINE.exec(content);
  if (boundary) {
    const short = content.slice(0, boundary.index).trimEnd();
    const explanation = content.slice(boundary.index + boundary[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!short.trim()) return { content: explanation };
    return { content: explanation.trim() ? short + "\n\n" + explanation : short, shortAnswerEnd: short.length };
  }
  const lineStart = content.lastIndexOf("\n") + 1;
  const tail = content.slice(lineStart).trimStart();
  // SSE chunks can split the separator anywhere, including its opening "<".
  if (tail && EXPLANATION_SEPARATOR.startsWith(tail)) {
    return { content: content.slice(0, lineStart).trimEnd() };
  }
  return { content };
}

export function streamingGuidedAnswer(raw: string): GuidedAnswer {
  return splitGuidedAnswer(hideSuggestionBlock(raw));
}

export function guidedShortAnswer({ content, shortAnswerEnd }: Pick<DiveTurn, "content" | "shortAnswerEnd">): string {
  const hasBoundary = typeof shortAnswerEnd === "number" && Number.isInteger(shortAnswerEnd) && shortAnswerEnd > 0 && shortAnswerEnd <= content.length;
  const text = splitDiagram(hasBoundary ? content.slice(0, shortAnswerEnd) : content).text;
  // An older reply can be shown whole if it's already compact. Leave a
  // longer reply in its thread until it has a generated short answer.
  if (!hasBoundary && text.trim().length > 480) return "";
  // A colon can introduce material that belongs in the short answer itself.
  // Keep the full answer available if the model split at that point anyway.
  const plain = markersToPages(text, [], String);
  return plain && !plain.endsWith(":") ? text : "";
}

export function readGuideOrientation(raw: string): string {
  const text = /^\s*<orientation>([\s\S]*?)<\/orientation>/i.exec(raw)?.[1].trim() ?? "";
  return text.length <= 420 ? text.replace(/\s*\n\s*/g, " ") : "";
}

export function guideDiscovery(panel: DivePanel) {
  const index = panel.turns.findLastIndex((turn, i) =>
    turn.role === "assistant" && panel.turns[i - 1]?.content === DISCOVER_QUESTIONS);
  const reply = panel.turns[index];
  const orientation = reply && !reply.status && reply.content !== NO_GUIDE_ORIENTATION && !reply.content.startsWith("⚠️") ? reply.content : "";
  return { index, reply, orientation };
}

export function forDiveRequest(panel: DivePanel, content: string): DivePanel {
  // A saved guide can still be read through the classic view when the
  // experiment is off. Only the discovery request uses the guide prompt.
  return panel.guided === "guide" && content !== DISCOVER_QUESTIONS ? { ...panel, guided: undefined } : panel;
}

export interface GuidedQuestionRequest {
  parentId: string;
  question: string;
  answerTurnIndex?: number;
  attachments: Attachment[];
  diagram?: boolean;
}

export function guidedRoot(panels: DivePanel[], id: string): DivePanel | null {
  const root = rootPanelOf(panels, id);
  return root?.guided === "guide" ? root : null;
}

export function createGuidedQuestion(parent: DivePanel, request: GuidedQuestionRequest, pageLabel: (n: number) => string): DivePanel {
  const answer = parent.turns[request.answerTurnIndex ?? -1];
  const context = answer?.role === "assistant" && !answer.status ? answer : undefined;
  return {
    ...createNestedPanel({
      parentId: parent.id,
      selection: request.question,
      contextText: parent.guided !== "guide" && context ? markersToPages(context.content, context.sources ?? [], pageLabel) : "",
      inheritedSources: context ? citedSources(context.content, context.sources ?? []) : undefined,
    }),
    guided: "question",
  };
}

export function guidedReply(panel: DivePanel, raw: string): ReturnType<typeof splitSuggestions> & Pick<GuidedAnswer, "shortAnswerEnd"> {
  const { body, suggestions } = splitSuggestions(raw);
  const currentQuestion = panel.guided === "question" ? panel.selection.trim().toLowerCase() : "";
  const questions = mergeSuggestions(
    suggestions.filter(({ kind, text }) => kind === "ask" && text.toLowerCase() !== currentQuestion).map(({ kind, text }) => ({ kind, text })),
    undefined,
  );
  if (panel.guided === "guide") {
    return { body: readGuideOrientation(body) || NO_GUIDE_ORIENTATION, suggestions: questions };
  }
  const answer = splitGuidedAnswer(body);
  return { body: answer.content, shortAnswerEnd: answer.shortAnswerEnd, suggestions: questions.slice(0, MAX_GUIDED_FOLLOW_UPS) };
}

export function questionAnswer(panel: DivePanel) {
  const original = panel.turns.findIndex((turn, index) =>
    turn.role === "assistant" && !turn.status && !panel.turns[index - 1]?.simplify);
  const simpler = panel.turns.findLastIndex((turn, index) =>
    turn.role === "assistant" && !turn.status && panel.turns[index - 1]?.simplify === true);
  return { original, simpler };
}
