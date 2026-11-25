import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Ellipsis, PanelRightOpen, Paperclip } from "lucide-react";
import MathRun from "../document/MathRun";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import AttachmentChips from "../grounding/AttachmentChips";
import QuestionComposer from "../grounding/QuestionComposer";
import { addAttachment, makeAttachment } from "../grounding/attachments";
import { saveNotebookExcerpt } from "../notebook/capture";
import { useNotebook } from "../notebook/context";
import { useReaderDraft } from "../notebook/drafts";
import type { DeepDiveViewProps } from "./DeepDiveView";
import DivePanelPane, { InlineDiveAnswer, type DivePanelPaneProps } from "./DivePanelPane";
import InlineDiveMath from "./InlineDiveMath";
import { splitDiagram } from "./diagram";
import { DISCOVER_QUESTIONS, guidedShortAnswer, NO_GUIDE_ORIENTATION, questionAnswer, readGuideOrientation, SIMPLIFY_ANSWER, type GuidedQuestionRequest } from "./guided";
import { childrenOf, panelById } from "./tree";
import type { DiveHighlight, DiveHighlightPlacement, DiveJobState, DivePanel, DiveTurnRequest } from "./types";
import "./guidedDive.css";

type GuidedViewProps = DeepDiveViewProps & {
  guide: DivePanel;
  paneProps: (id: string) => DivePanelPaneProps;
  diagrams: boolean;
};
type CreateQuestion = GuidedViewProps["onCreateGuidedQuestion"];

export default function GuidedDiveView({
  guide, focusId, turnRequest, panels, jobs, paneProps, scrollPositions, rootSlotRef, onFocusChange,
  onCreateGuidedQuestion, onJumpToSource, onReturnToPassage, diagrams,
}: GuidedViewProps) {
  const focused = focusId === guide.id ? null : panelById(panels, focusId);
  const focusedId = focused?.id;
  const [sourceVisible, setSourceVisible] = useState(false);
  const [originalAnswers, setOriginalAnswers] = useState<Record<string, boolean>>({});
  const selectOriginal = useCallback((id: string, original: boolean) => {
    setOriginalAnswers((answers) => Boolean(answers[id]) === original ? answers : { ...answers, [id]: original });
  }, []);
  const overviewRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sourceToggle = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const overviewKey = "questions:" + guide.id;
  const overview = paneProps(guide.id);
  const revealSource = (navigate: () => void) => {
    setSourceVisible(true);
    requestAnimationFrame(() => {
      sourceToggle.current?.focus({ preventScroll: true });
      navigate();
    });
  };
  const jump: GuidedViewProps["onJumpToSource"] = (source) => revealSource(() => onJumpToSource(source));
  const showOriginal = guide.anchorHighlightId || guide.pageNumber !== undefined
    ? () => revealSource(() => onReturnToPassage(guide.id, { keepQuestionOpen: true }))
    : undefined;

  useLayoutEffect(() => {
    if (focusedId) headingRef.current?.focus({ preventScroll: true });
    else if (overviewRef.current) {
      overviewRef.current.scrollTop = scrollPositions.get(overviewKey) ?? 0;
      openerRef.current?.focus({ preventScroll: true });
      openerRef.current = null;
    }
  }, [focusedId, overviewKey, scrollPositions]);

  const open = (id: string, opener?: HTMLButtonElement) => {
    if (opener) {
      openerRef.current = opener;
      const top = overviewRef.current?.scrollTop;
      if (top !== undefined) scrollPositions.set(overviewKey, top);
    }
    setSourceVisible(false);
    onFocusChange(id);
  };

  return (
    <div className="deep-dive-view guided-dive">
      <nav className="guided-navigation" aria-label="Deep Dive">
        <button type="button" className="guided-action" onClick={() => onFocusChange(null)}>
          <ArrowLeft size={15} aria-hidden /> Back to reading
        </button>
        <span>Deep Dive</span>
        <button type="button" ref={sourceToggle} className="guided-action guided-source-toggle" aria-pressed={sourceVisible} onClick={() => {
          if (!sourceVisible && focused && showOriginal) showOriginal();
          else setSourceVisible(!sourceVisible);
        }}>
          {sourceVisible ? (focused ? "Back to thread" : "Back to questions") : focused && showOriginal ? "Original passage" : "Source"}
        </button>
      </nav>
      <div className={"guided-layout" + (focused ? " has-thread" : "") + (sourceVisible ? " showing-source" : "")}>
        <div className="guided-document"><div className="pdf-pane-slot" ref={rootSlotRef} /></div>
        <section className="guided-overview" aria-label="Questions about the selection" ref={overviewRef} onScroll={(event) => {
          if (event.currentTarget.clientHeight) scrollPositions.set(overviewKey, event.currentTarget.scrollTop);
        }}>
          <GuidedOverview key={guide.id} {...overview} originalAnswers={originalAnswers} jobs={jobs}
            open={open} onCreate={onCreateGuidedQuestion} onJumpToSource={jump} onShowOriginal={showOriginal} />
        </section>
        {focused ? (
          <section className="guided-thread" aria-label="Question thread">
            <nav className="guided-thread-nav" aria-label="Question thread">
              <button type="button" className="guided-action" onClick={() => open(guide.id)}>
                <ArrowLeft size={14} aria-hidden /> All questions
              </button>
              {focused.parentId && focused.parentId !== guide.id ? (
                <button type="button" className="guided-action" onClick={() => open(focused.parentId!)}>Parent question</button>
              ) : null}
              {showOriginal ? <button type="button" className="guided-action guided-thread-original" onClick={showOriginal}>
                <BookOpen size={14} aria-hidden /> Original passage
              </button> : null}
            </nav>
            <h2 ref={headingRef} tabIndex={-1}><InlineDiveMath text={focused.selection || focused.label} /></h2>
            <GuidedThread key={focused.id} {...paneProps(focused.id)} open={open} onCreate={onCreateGuidedQuestion}
              showOriginal={Boolean(originalAnswers[focused.id])} selectOriginal={selectOriginal}
              onJumpToSource={jump} diagrams={diagrams} turnRequest={turnRequest?.panelId === focused.id ? turnRequest : undefined} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ContextPicker({ onAdd }: { onAdd: (text: string) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  return (
    <details className="guided-context" ref={details}>
      <summary className="guided-action"><Paperclip size={14} aria-hidden /> Add context</summary>
      <div className="guided-context-body">
        <p>Select text or a region in the document and choose <strong>Add to question</strong>, or add background here.</p>
        <label htmlFor={id}>Background for this question</label>
        <textarea id={id} value={text} rows={2} onChange={(event) => setText(event.target.value)} maxLength={3000} />
        <button type="button" className="guided-action" disabled={!text.trim()} onClick={() => {
          onAdd(text.trim());
          setText("");
          if (details.current) {
            details.current.open = false;
            details.current.querySelector("summary")?.focus();
          }
        }}>Attach context</button>
      </div>
    </details>
  );
}

function QuestionRow({ question, panels, highlights, originalAnswers, open, pageLabel, onJump, jobs, initiallyOpen = false }: {
  question: DivePanel;
  panels: DivePanel[];
  highlights: DiveHighlight[];
  originalAnswers: Record<string, boolean>;
  open: (id: string, opener?: HTMLButtonElement) => void;
  pageLabel: DivePanelPaneProps["pageLabel"];
  onJump: DivePanelPaneProps["onJumpToSource"];
  jobs: Record<string, DiveJobState>;
  initiallyOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const threadButton = useRef<HTMLButtonElement>(null);
  const { original, simpler } = questionAnswer(question);
  const turnIndex = simpler >= 0 && !originalAnswers[question.id] ? simpler : original;
  const answer = question.turns[turnIndex];
  const children = childrenOf(panels, question.id);
  const job = jobs[question.id];
  const shortAnswer = answer ? guidedShortAnswer(answer) : job?.shortAnswerEnd !== undefined
    ? guidedShortAnswer({ content: job.text, shortAnswerEnd: job.shortAnswerEnd })
    : "";
  return (
    <li className={"guided-question" + (expanded ? " is-expanded" : "")}>
      <button type="button" className="guided-action guided-open-thread" ref={threadButton}
        title="Open thread" aria-label={"Open thread: " + question.selection}
        onClick={(event) => open(question.id, event.currentTarget)}><PanelRightOpen size={16} aria-hidden /><span>Open thread</span></button>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary><InlineDiveMath text={question.selection || question.label} /></summary>
        {expanded ? <div className="guided-preview">
          {shortAnswer ? (
            <InlineDiveAnswer content={shortAnswer} sources={answer ? answer.sources : job?.sources} turnIndex={answer ? turnIndex : question.turns.length}
              highlights={highlights.filter((mark) => mark.panelId === question.id)}
              pageLabel={pageLabel} onJumpToSource={onJump} onOpenDive={(id) => open(id, threadButton.current ?? undefined)} />
          ) : <p role={job ? "status" : undefined}>{answer ? "The full answer is in the thread." : job ? "Preparing answer…" : "Open the thread to continue this question."}</p>}
          {children.length ? (
            <ul className="guided-questions">
              {children.map((child) => <QuestionRow key={child.id} question={child} panels={panels} highlights={highlights}
                originalAnswers={originalAnswers} open={open} pageLabel={pageLabel} onJump={onJump} jobs={jobs} />)}
            </ul>
          ) : null}
        </div> : null}
      </details>
    </li>
  );
}

function GuidedOverview({ panel, allPanels, job, attachments, onAddToQuestion, onClearAttachments, onRemoveAttachment,
  onCancel, onSendMessage, pageLabel, onJumpToSource, onShowOriginal, open, onCreate, jobs, diveHighlights, originalAnswers }: DivePanelPaneProps & {
  open: (id: string, opener?: HTMLButtonElement) => void;
  onCreate: CreateQuestion;
  jobs: Record<string, DiveJobState>;
  originalAnswers: Record<string, boolean>;
  onShowOriginal?: () => void;
}) {
  const notebook = useNotebook();
  const [draft, setDraft] = useReaderDraft(notebook?.store.drafts, "dive:" + panel.id);
  const [custom, setCustom] = useState(false);
  const [choose, setChoose] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const customRef = useRef<HTMLInputElement>(null);
  const children = childrenOf(allPanels, panel.id);
  const discoveryIndex = panel.turns.findLastIndex((turn, index) =>
    turn.role === "assistant" && panel.turns[index - 1]?.content === DISCOVER_QUESTIONS);
  const latest = panel.turns[discoveryIndex];
  const orientation = job ? readGuideOrientation(job.text) :
    latest && !latest.status && latest.content !== NO_GUIDE_ORIENTATION ? latest.content : "";
  const asked = new Set(children.map((child) => child.selection.trim().toLowerCase()));
  const suggestions = (latest?.suggestions ?? []).map((suggestion) => suggestion.text).filter((question) => !asked.has(question.toLowerCase()));
  const questions = [...new Set([...suggestions.filter((question) => selected.includes(question)), draft.trim()].filter(Boolean))];
  const submit = (values: string[]) => {
    const added = values.map((question) => onCreate({ parentId: panel.id, question, attachments })).filter(Boolean);
    if (!added.length) return;
    onClearAttachments();
    setDraft("");
    setCustom(false);
    setChoose(false);
    setSelected([]);
  };
  const discovering = Boolean(job);
  const canRetry = !discovering && !latest?.suggestions?.length && !children.length;
  const startingPoint = panel.selectionImage
    ? "What does this image show, and how does it connect to the text?"
    : "What is the main connection I need to understand this passage?";
  return (
    <div className="guided-overview-content">
      <figure className={"guided-excerpt" + (orientation ? " has-orientation" : "")}>
        <blockquote className="guided-excerpt-text">
          {panel.selectionImage ? <img alt="Selected region" src={"data:" + panel.selectionImage.mediaType + ";base64," + panel.selectionImage.data} /> : null}
          {panel.selectionParts ? (
            <div className="guided-excerpt-content">{panel.selectionParts.map((part, index) =>
              part.kind === "math" ? <MathRun key={index} value={part.value} display={part.display} fallback={part.value} /> : part.value)}
            </div>
          ) : panel.selection ? <p><InlineDiveMath text={panel.selection} /></p> : null}
        </blockquote>
        {onShowOriginal ? <figcaption><button type="button" className="guided-action" onClick={onShowOriginal}>
          <BookOpen size={14} aria-hidden /> View original passage
        </button></figcaption> : null}
      </figure>
      {orientation ? <div className="guided-orientation">
        <AnswerMarkdown content={orientation} sources={(job ? job.sources : latest?.sources) ?? []}
          pageLabel={pageLabel} onJump={onJumpToSource} />
      </div> : null}
      {children.length ? <>
        <h2>Your questions</h2>
        <ul className="guided-questions">
          {children.map((child, index) => (
            <QuestionRow key={child.id} question={child} panels={allPanels} open={open}
              pageLabel={pageLabel} onJump={onJumpToSource} initiallyOpen={index === 0}
              jobs={jobs} highlights={diveHighlights} originalAnswers={originalAnswers} />
          ))}
        </ul>
      </> : null}
      {!children.length || choose || Boolean(attachments.length) || Boolean(draft) ? (
        <form className="guided-chooser" onSubmit={(event) => { event.preventDefault(); submit(questions); }}>
          <h2>What would help you understand this?</h2>
          {discovering ? <div className="guided-actions"><span role="status">Finding likely questions…</span><button type="button" className="guided-action" onClick={() => onCancel(panel.id)}>Stop</button></div> : null}
          {canRetry ? <div className="guided-actions">
            {latest?.error ? <span role="status">{latest.error}</span> : null}
            <button type="button" className="guided-action" onClick={() => {
              const previous = panel.turns[discoveryIndex - 1];
              void onSendMessage(panel.id, DISCOVER_QUESTIONS, undefined, {
                retry: discoveryIndex >= 0 && discoveryIndex === panel.turns.length - 1,
                attachments: previous?.attachments ?? [],
              });
            }}>{latest ? "Try suggestions again" : "Find likely questions"}</button>
          </div> : null}
          {suggestions.length ? <fieldset className="guided-choices" aria-label="Suggested questions">
            {suggestions.map((question) => <label key={question}>
              <input type="checkbox" checked={selected.includes(question)} onChange={(event) => setSelected((values) => event.target.checked ? [...values, question] : values.filter((value) => value !== question))} />
              <InlineDiveMath text={question} />
            </label>)}
          </fieldset> : null}
          {custom || draft ? <input className="guided-own-question" aria-label="Your question" placeholder="A few words are enough…" ref={customRef} value={draft} onChange={(event) => setDraft(event.target.value)} /> : null}
          <AttachmentChips attachments={attachments} pageLabel={pageLabel} onRemove={onRemoveAttachment} />
          <div className="guided-actions guided-chooser-actions">
            {questions.length ? <button type="submit" className="guided-primary">{questions.length === 1 ? "Answer question" : "Answer " + questions.length + " questions"}</button> : null}
            {!custom && !draft ? <button type="button" className="guided-action" onClick={() => {
              setCustom(true);
              requestAnimationFrame(() => customRef.current?.focus());
            }}>Ask your own</button> : null}
            <ContextPicker onAdd={(text) => onAddToQuestion("context", text)} />
            {!discovering && !children.length && !questions.length ? <button type="button" className="guided-action" onClick={() => submit([startingPoint])}>Give me a starting point</button> : null}
          </div>
        </form>
      ) : (
        <button type="button" className="guided-action guided-more-questions" onClick={() => setChoose(true)}>
          {suggestions.length ? "More questions" : "Ask another question"} <ChevronRight size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function GuidedThread({ open, onCreate, diagrams, turnRequest, showOriginal, selectOriginal, ...pane }: DivePanelPaneProps & {
  open: (id: string) => void;
  onCreate: CreateQuestion;
  diagrams: boolean;
  turnRequest?: DiveTurnRequest;
  showOriginal: boolean;
  selectOriginal: (id: string, original: boolean) => void;
}) {
  const { panel, allPanels, attachments, job, pageLabel, onSendMessage, onAddToQuestion, onClearAttachments, onRemoveAttachment } = pane;
  const notebook = useNotebook();
  const [draft, setDraft] = useReaderDraft(notebook?.store.drafts, "dive:" + panel.id);
  const [composing, setComposing] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const { original, simpler } = questionAnswer(panel);
  const originalId = panel.turns[original]?.id;
  const simplerId = panel.turns[simpler]?.id;
  const requestedMark = pane.diveHighlights.find((mark) => mark.id === pane.scrolledToDiveHighlightId && mark.panelId === panel.id);
  const requestedTurn = turnRequest?.turnId ?? panel.turns[requestedMark?.turnIndex ?? -1]?.id;
  useLayoutEffect(() => {
    if (requestedTurn && requestedTurn === originalId) selectOriginal(panel.id, true);
    if (requestedTurn && requestedTurn === simplerId) selectOriginal(panel.id, false);
  }, [turnRequest, panel.id, requestedTurn, originalId, simplerId, selectOriginal]);
  const index = !showOriginal && simpler >= 0 ? simpler : original;
  const answer = panel.turns[index];
  const children = childrenOf(allPanels, panel.id);
  const suggestions = (answer?.suggestions ?? []).filter((item) => item.kind === "ask" &&
    !children.some((child) => child.selection.trim().toLowerCase() === item.text.toLowerCase()));
  const latest = panel.turns.at(-1);
  const failed = !job && latest?.role === "assistant" && latest.status;
  const lastQuestion = panel.turns.findLast((turn) => turn.role === "user");
  const excluded = Boolean(answer?.content.trimStart().startsWith("[not-covered]"));
  const compose = () => {
    setComposing(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const follow = (question: string, options: Partial<Pick<GuidedQuestionRequest, "answerTurnIndex" | "attachments" | "diagram">> = {}) => {
    const id = onCreate({ parentId: panel.id, question, answerTurnIndex: index, attachments, ...options });
    if (!id) return;
    if (!options.diagram) {
      onClearAttachments();
      setDraft("");
      setComposing(false);
    }
    open(id);
    return id;
  };
  const diveIntoSelection = (selection: string, { turnIndex = index, occurrence }: DiveHighlightPlacement, mark?: DiveHighlight) => {
    const existing = mark ?? pane.diveHighlights.find((item) =>
      item.panelId === panel.id && item.turnIndex === turnIndex && item.text === selection && (item.occurrence ?? 0) === (occurrence ?? 0));
    if (existing?.divePanelId && panelById(allPanels, existing.divePanelId)) {
      open(existing.divePanelId);
      return;
    }
    const attachment = makeAttachment("answer", selection);
    const id = follow("Can you explain this part of your answer?", {
      answerTurnIndex: turnIndex,
      attachments: attachment ? addAttachment(attachments, attachment) : attachments,
    });
    if (!id) return;
    if (existing) pane.onEditHighlight(existing.id, { divePanelId: id });
    else pane.onAddHighlight(panel.id, selection, "", { turnIndex, occurrence, divePanelId: id });
  };
  const footer = (
    <div className="guided-thread-footer">
      {failed ? <div className="guided-actions">
        <span role="status">{latest?.error || "The answer was interrupted."}</span>
        {lastQuestion ? <button type="button" className="guided-action" onClick={() => void onSendMessage(
          panel.id, lastQuestion.content, undefined, { retry: true, attachments: lastQuestion.attachments ?? [], diagram: lastQuestion.diagram, simplify: lastQuestion.simplify },
        )}>Retry</button> : null}
      </div> : null}
      {answer && !job && !excluded ? (
        <div className="guided-actions guided-answer-actions">
          {simpler >= 0 ? <button type="button" className="guided-action" onClick={() => selectOriginal(panel.id, !showOriginal)}>{showOriginal ? "Show simpler answer" : "Show original"}</button>
            : !failed ? <button type="button" className="guided-action" onClick={() => {
              selectOriginal(panel.id, false);
              void onSendMessage(panel.id, SIMPLIFY_ANSWER, undefined, { simplify: true, reuseSources: true, attachments: panel.turns[0]?.attachments ?? [] });
            }}>Simplify answer</button> : null}
          {notebook || diagrams && !splitDiagram(answer.content).code ? <details ref={menuRef} className="guided-menu">
            <summary className="guided-action" aria-label="Answer options" title="Answer options"><Ellipsis size={18} aria-hidden /></summary>
            <div className="guided-menu-options" onClick={() => { if (menuRef.current) menuRef.current.open = false; }}>
              {diagrams && !splitDiagram(answer.content).code ? <button type="button" onClick={() => follow("Show this as a diagram.", { diagram: true, attachments: [] })}>Show a diagram</button> : null}
              {notebook ? <button type="button" onClick={() => void saveNotebookExcerpt(notebook.store, panel.selection + "\n\n" + answer.content,
                { context: panel.selection, sources: answer.sources, conversationId: panel.id, turnId: answer.id })}>Save to Notebook</button> : null}
            </div>
          </details> : null}
        </div>
      ) : null}
      {children.length ? <div className="guided-children">
        <h3>Follow-up questions</h3>
        <ul className="guided-questions">{children.map((child) => <li key={child.id}>
          <button type="button" className="guided-child" onClick={() => open(child.id)}>
            <InlineDiveMath text={child.selection || child.label} /><ChevronRight size={16} aria-hidden />
          </button>
        </li>)}</ul>
      </div> : null}
      {!job && !excluded && !draft.trim() && suggestions.length ? <div className="guided-follow-up">
        <h3>Suggested follow-ups</h3>
        <ul className="guided-questions">{suggestions.map(({ text }) => <li key={text}>
          <button type="button" className="guided-child guided-suggested-follow-up" onClick={() => follow(text)}>
            <InlineDiveMath text={text} /><ChevronRight size={16} aria-hidden />
          </button>
        </li>)}</ul>
      </div> : null}
      {answer ? composing || attachments.length || draft ? (
        <div className="guided-follow-up">
          <QuestionComposer value={draft} onChange={setDraft} onSubmit={() => follow(draft.trim())} placeholder="Ask a follow-up…"
            submitLabel="Ask" busyLabel="Asking…" attachments={attachments} pageLabel={pageLabel}
            onRemoveAttachment={onRemoveAttachment} textareaRef={composerRef} />
          <ContextPicker onAdd={(text) => onAddToQuestion("context", text)} />
        </div>
      ) : <button type="button" className="guided-action guided-follow-up-button" onClick={compose}>Ask a follow-up</button> : null}
    </div>
  );
  return <DivePanelPane {...pane}
    onOpenDive={open}
    onNestedDive={({ selection, turnIndex, occurrence }) => diveIntoSelection(selection, { turnIndex, occurrence })}
    onDiveFromHighlight={(highlight) => diveIntoSelection(highlight.text, highlight, highlight)}
    guidedAnswer={{ turnIndex: index, footer, onAttach: compose }} />;
}
