import { useRef, useState } from "react";
import type { DiveHighlight } from "./types";
import { useNotebook } from "../notebook/context";
import HighlightToolbar from "../components/HighlightToolbar";
import type { AnchorRect } from "./useFlippedPlacement";
import FloatingTip from "../components/FloatingTip";

type HighlightStyleOverride = Pick<DiveHighlight, "highlightColor" | "highlightStyle">;
type HighlightStyle = NonNullable<DiveHighlight["highlightStyle"]>;

export interface DiveSelectionTipProps {
  selectionText: string;
  anchorRect: AnchorRect;
  onAddHighlight: (text: string, comment: string, style?: HighlightStyleOverride) => string;
  onDiveDeeper: () => void;
  // Set when this text already seeded a dive (a dive marker with no
  // highlight of its own): the Dive button then reopens it.
  divePanelId?: string;
  onOpenDive?: (divePanelId: string) => void;
  onPin: () => void;
  onAddToQuestion?: () => void;
  onClose: () => void;
}

// The dive-panel equivalent of ExpandableTip: the same HighlightToolbar, for
// a plain-text selection inside AI dialogue instead of a PDF text
// selection. Having no
// react-pdf-highlighter tip-container to be positioned by — renders itself
// as a fixed-position popover, flipped above/below its anchor the same way
// (see useFlippedPlacement) so it never covers the text being selected.
export default function DiveSelectionTip({
  selectionText,
  anchorRect,
  onAddHighlight,
  onDiveDeeper,
  divePanelId,
  onOpenDive,
  onPin,
  onAddToQuestion,
  onClose,
}: DiveSelectionTipProps) {
  const notebook = useNotebook();
  const [pendingStyle, setPendingStyle] = useState<HighlightStyle>("highlight");
  const tipRef = useRef<HTMLDivElement>(null);

  const finalize = (style: HighlightStyleOverride | undefined, commentText: string) => {
    onAddHighlight(selectionText, commentText, style);
    onClose();
  };

  const commentControls = { showComment: false, panel: null, button: <button type="button" className="TextHighlight__comment-button" onClick={() => {
    const id = onAddHighlight(selectionText, "", { highlightStyle: pendingStyle });
    const entry = notebook?.store.entryForCapture(`dive:${id}`); if (entry) notebook?.store.reveal(entry.id);
    onClose();
  }}>Note</button> };

  return (
    <FloatingTip anchorRect={anchorRect} onClose={onClose} deps={[commentControls.showComment]}>
      <div ref={tipRef}>
      <HighlightToolbar
        copyText={selectionText}
        note={commentControls}
        divePanelId={divePanelId}
        onOpenDive={onOpenDive}
        onStartDive={onDiveDeeper}
        onPin={onPin}
        onAddToQuestion={onAddToQuestion}
        addToQuestionTitle="Add to this dive's next question"
        activeStyle={pendingStyle}
        onStyleChange={setPendingStyle}
        onColorChange={(presetColor) => finalize({ highlightColor: presetColor, highlightStyle: pendingStyle }, "")}
      />
      </div>
    </FloatingTip>
  );
}
