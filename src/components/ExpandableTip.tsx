import { useLayoutEffect, useRef, useState } from "react";
import type { GhostHighlight, ScaledPosition } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import type { HighlightPen } from "./AppRail";
import HighlightToolbar from "./HighlightToolbar";
import GlossaryCard from "../glossary/GlossaryCard";
import type { GlossaryStore } from "../glossary/store";
import type { GlossaryEntry, GlossaryRef } from "../glossary/types";
import { isGlossaryCandidate, MAX_TERM_WORDS } from "../glossary/textIndex";

type HighlightStyleOverride = Pick<CommentedHighlight, "highlightColor" | "highlightStyle">;
type HighlightStyle = NonNullable<CommentedHighlight["highlightStyle"]>;

export interface GlossaryTipBindings {
  onSaveToNotebook?: (entry: GlossaryEntry) => void;
  store: GlossaryStore;
  // Adds the term (or finds it already there) and starts its lookup;
  // returns the entry's id, or null if the selection isn't a usable term.
  onAdd: (selection: string, pageNumber: number) => string | null;
  pageLabel: (pageNumber: number) => string;
  onOpenInGlossary: (entryId: string) => void;
  // To a passage the glossary links to — where the document defines a term.
  onJumpToRef: (ref: GlossaryRef) => void;
  onRetry: (entryId: string) => void;
}

interface ExpandableTipProps {
  addHighlight: (
    highlight: GhostHighlight,
    comment: string,
    style?: HighlightStyleOverride,
  ) => string;
  onOpenNote: (id: string) => void;
  pen: HighlightPen;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onPin: (selectionText: string, pageNumber: number, ghost?: GhostHighlight) => void;
  // Text, or an area selection's image, added to the next question.
  onAddToQuestion: (content: GhostHighlight["content"], position: ScaledPosition) => void;
  addToQuestionTitle: () => string; // read when shown: Ask's, or the open dive's
  glossary: GlossaryTipBindings;
}

export default function ExpandableTip({
  addHighlight,
  onOpenNote,
  pen,
  onDiveDeeper,
  onPin,
  onAddToQuestion,
  addToQuestionTitle,
  glossary,
}: ExpandableTipProps) {
  const [pendingStyle, setPendingStyle] = useState<HighlightStyle>(pen.style);
  // Set once "Glossary" is clicked: the tip then shows that entry's
  // definition card in place of the toolbar.
  const [glossaryEntryId, setGlossaryEntryId] = useState<string | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const { getCurrentSelection, setTip, updateTipPosition, removeGhostHighlight } =
    usePdfHighlighterContext();

  const currentSelection = getCurrentSelection();
  const hasTextSelection = Boolean(currentSelection?.content.text);

  const finalize = (style: HighlightStyleOverride | undefined, commentText: string) => {
    const selection = getCurrentSelection();
    if (!selection) return;
    // makeGhostHighlight() (rather than reading selection.content/type/position
    // directly) is what tells the highlighter to clear its underlying mouse/text
    // selection overlay — skipping it left the dashed area-selection box (or the
    // native text selection) stuck on the page after the highlight was created.
    // removeGhostHighlight() then clears the resulting ghost/editing state now
    // that addHighlight has turned it into a real, persisted highlight — without
    // it the highlighter still considers itself "editing," which (among other
    // things) suppresses hover tooltips on every highlight.
    addHighlight(selection.makeGhostHighlight(), commentText, style);
    removeGhostHighlight();
    setTip(null);
  };

  const commentControls = {
    showComment: false, panel: null,
    button: <button type="button" className="TextHighlight__comment-button" title="Write a note" onClick={(event) => {
      event.stopPropagation(); const selection = getCurrentSelection(); if (!selection) return;
      const id = addHighlight(selection.makeGhostHighlight(), "", { highlightColor: pen.color, highlightStyle: pendingStyle });
      removeGhostHighlight(); setTip(null); onOpenNote(id);
    }}>Note</button>,
  };
  useLayoutEffect(() => { updateTipPosition?.(); }, [updateTipPosition]);

  const handleDive = () => {
    const selection = getCurrentSelection();
    if (!selection) return;
    onDiveDeeper(selection.makeGhostHighlight());
    removeGhostHighlight();
    setTip(null);
  };

  const handlePin = () => {
    const selection = getCurrentSelection();
    const text = selection?.content.text;
    if (!text) return;
    onPin(text, selection.position.boundingRect.pageNumber, selection.makeGhostHighlight());
    removeGhostHighlight(); setTip(null);
  };

  const handleAddToQuestion = () => {
    const selection = getCurrentSelection();
    if (!selection || (!selection.content.text && !selection.content.image)) return;
    onAddToQuestion(selection.content, selection.position);
  };

  const handleAddToGlossary = () => {
    const selection = getCurrentSelection();
    const text = selection?.content.text;
    if (!text) return;
    const entryId = glossary.onAdd(text, selection.position.boundingRect.pageNumber);
    if (entryId) setGlossaryEntryId(entryId);
  };

  if (glossaryEntryId) {
    return (
      <div className="expandable-tip" ref={tipRef}>
        <GlossaryCard
          onSaveToNotebook={glossary.onSaveToNotebook}
          store={glossary.store}
          entryId={glossaryEntryId}
          onOpenInGlossary={(entryId) => {
            glossary.onOpenInGlossary(entryId);
            setTip(null);
          }}
          onRetry={glossary.onRetry}
          onJumpToRef={(ref) => {
            setTip(null);
            glossary.onJumpToRef(ref);
          }}
          pageLabel={glossary.pageLabel}
          onLayoutChange={updateTipPosition}
        />
      </div>
    );
  }

  const selectionText = currentSelection?.content.text ?? "";

  return (
    <div className="expandable-tip" ref={tipRef}>
      <HighlightToolbar
        classPrefix={hasTextSelection ? "TextHighlight" : "AreaHighlight"}
        copyText={currentSelection?.content.text || undefined}
        note={commentControls}
        onStartDive={handleDive}
        onPin={hasTextSelection ? handlePin : undefined}
        onAddToGlossary={hasTextSelection ? handleAddToGlossary : undefined}
        onAddToQuestion={handleAddToQuestion}
        addToQuestionTitle={addToQuestionTitle()}
        glossaryDisabledReason={
          isGlossaryCandidate(selectionText) ? undefined : `Select a single term (up to ${MAX_TERM_WORDS} words)`
        }
        activeColor={pen.color}
        activeStyle={pendingStyle}
        onStyleChange={hasTextSelection ? setPendingStyle : undefined}
        onColorChange={(presetColor) =>
          finalize(
            hasTextSelection
              ? { highlightColor: presetColor, highlightStyle: pendingStyle }
              : { highlightColor: presetColor },
            "",
          )
        }
      />
    </div>
  );
}
