import type { AskContext } from "../ask/job";
import type { AskStore } from "../ask/store";
import type { AskTurn } from "../ask/types";
import type { SendOptions } from "../deepdive/DivePanelPane";
import { prepareDiveSources, divePromptOptions, type DiveRequestContext } from "../deepdive/diveRequest";
import { streamDiveReply } from "../deepdive/api";
import { abortable } from "../deepdive/job";
import { getExperiments } from "../deepdive/experiments";
import { historyTurns } from "../deepdive/tree";
import { buildDivePrompt } from "../deepdive/prompts";
import { labelWithRegistry } from "../deepdive/sourceRegistry";
import { splitSuggestions, mergeSuggestions } from "../deepdive/suggestions";
import { attachmentImages, attachmentInstructions } from "../grounding/attachments";
import { markersToPages } from "../grounding/citations";
import { nativeDivePanels } from "./nativeDives";
import { DocumentEngine } from "./engine";
import { forDiveRequest, guidedReply, guidedRoot, streamingGuidedAnswer } from "../deepdive/guided";

// The same retrieval, prompts, stable source labels, suggestions and history
// as PDF dives, with semantic source locations in place of page rectangles.
export async function runNativeDive(store: AskStore, id: string, question: string, context: AskContext, options: SendOptions = {}, onChunk?: (chunk: string) => void) {
  if (!(context.pdfDocument instanceof DocumentEngine)) throw new Error("The native document is not ready.");
  const engine = context.pdfDocument, thread = store.get(id);
  if (!thread) return;
  const now = () => new Date().toISOString();
  const signal = context.signal ?? new AbortController().signal;
  const experiments = getExperiments(), attachments = options.attachments ?? [];
  const previous = options.retry ? thread.turns.slice(0, thread.turns.at(-1)?.role === "assistant" ? -1 : undefined) : thread.turns;
  const turns: AskTurn[] = options.retry ? previous : [...previous, { id: crypto.randomUUID(), role: "user", content: question, at: now(), attachments, diagram: options.diagram, simplify: options.simplify }];
  store.update(id, (thread) => ({ ...thread, turns, updatedAt: now() }));
  const { panels } = nativeDivePanels(store.getSnapshot(), engine);
  const panel = panels.find((panel) => panel.id === id)!;
  const requestPanel = forDiveRequest(panel, question);
  const prior = { ...panel, turns: options.retry ? panel.turns : panel.turns.slice(0, -1) };
  const parent = panels.find((candidate) => candidate.id === panel.parentId) ?? null;
  const image = panel.selectionImage ?? (panel.guided === "question" ? guidedRoot(panels, id)?.selectionImage : undefined);
  const ctx: DiveRequestContext = { pdf: engine, pageLabel: context.pageLabel, panels, highlights: [], glossary: [], experiments };
  const index = turns.length;
  const update = (patch: Partial<AskTurn>, persist = false) => store.update(id, (thread) => ({ ...thread,
    turns: thread.turns.map((turn, i) => i === index ? { ...turn, ...patch } : turn), updatedAt: now() }), { persist });
  store.update(id, (thread) => ({ ...thread, turns: [...thread.turns, { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming", at: now() }] }), { persist: false });
  let text = "";
  try {
    let prepared = await abortable(prepareDiveSources(ctx, prior, question, { reuse: options.reuseSources ?? false, attachments, wider: options.wider }), signal);
    if (!prepared && (options.generalAllowed || requestPanel.guided === "guide" || image && requestPanel.guided)) prepared = { sources: [] };
    if (!prepared) throw new Error("The document text could not be prepared. Please retry.");
    const labeled = labelWithRegistry(prepared.sources.map((source) => ({ ...source,
      location: source.location ?? engine.anchorForRange(source.pageNumber, source.start, source.end),
      locationLabel: source.locationLabel ?? engine.labelForUnit(source.pageNumber),
    })), thread.sourceRegistry ?? []);
    const sources = labeled.sources;
    options.onSources?.(sources); update({ sources });
    if (!sources.length && !image && !attachments.some((attachment) => attachment.image) && !options.generalAllowed && requestPanel.guided !== "guide") {
      update({ content: "[not-covered] The passages I found don't answer this question.", status: undefined }, true); return;
    }
    const sent = historyTurns(panel.turns, 4, experiments.keepOpeningAnswer);
    const earlierQuestions = panel.turns.filter((turn) => turn.role === "user" && !sent.includes(turn)).map((turn) => turn.content.slice(0, 500)).slice(-8);
    const attachedLabels = attachments.length ? sources.filter((source) => source.via === "attached" || !source.chunkId).map((source) => source.label) : [];
    const prompt = buildDivePrompt(context.fileName, requestPanel, parent, { sources, pageLabel: context.pageLabel, attachmentNote: attachmentInstructions(attachments, attachedLabels, context.pageLabel) },
      { ...divePromptOptions(ctx, panel, sources, { splitAt: prepared.splitAt, diagram: options.diagram }), generalAllowed: options.generalAllowed, earlierQuestions });
    const images = attachmentImages(attachments).filter((attachment) => !requestPanel.guided || attachment.data !== image?.data);
    const messages = sent.map((turn, i) => ({ role: turn.role, content: turn.role === "assistant" ? markersToPages(turn.content, turn.sources ?? [], context.pageLabel) : turn.content,
      ...(i === 0 && image ? { image } : {}), ...(i === sent.length - 1 && images.length ? { images } : {}) }));
    const full = await streamDiveReply({ system: prompt.system, ...(prompt.suffix ? { systemSuffix: prompt.suffix } : {}), messages, signal,
      onText: (chunk) => {
        if (signal.aborted) return;
        text += chunk;
        onChunk?.(chunk);
        const { content, shortAnswerEnd } = requestPanel.guided === "question" ? streamingGuidedAnswer(text) : { content: text };
        update({ content, shortAnswerEnd });
      } });
    if (signal.aborted) throw new Error("Stopped");
    const reply: ReturnType<typeof guidedReply> = requestPanel.guided ? guidedReply(requestPanel, full) : experiments.suggestions ? splitSuggestions(full) : { body: full, suggestions: [] };
    const { body, suggestions, shortAnswerEnd } = reply;
    if (!body.trim()) throw new Error("The model returned an empty answer. Please retry.");
    store.update(id, (thread) => ({ ...thread, sourceRegistry: labeled.registry, ...(experiments.stableSources && !thread.baseSources ? { baseSources: sources } : {}),
      turns: thread.turns.map((turn, i) => i === index ? { ...turn, content: body, shortAnswerEnd, status: undefined, sources, suggestions: options.diagram ? [] : requestPanel.guided ? suggestions : mergeSuggestions(suggestions, sources) } : turn), updatedAt: now() }));
  } catch (error) {
    const message = signal.aborted ? "Stopped. You can retry this question." : error instanceof Error ? error.message : "The answer failed.";
    const partial = requestPanel.guided === "question" ? streamingGuidedAnswer(text).content : text;
    update({ content: partial ? `${partial}\n\n${message}` : message, shortAnswerEnd: undefined, status: "error" }, true);
  }
}
