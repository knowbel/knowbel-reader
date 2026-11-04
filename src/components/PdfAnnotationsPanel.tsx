import { useCallback, useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useDocumentOutline } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import type { DiveHighlight, DivePanel, GeneralNote, Pin } from "../deepdive/types";
import { panelById, rootPanelOf } from "../deepdive/tree";
import { treeAnswerCount } from "../deepdive/summary";
import type { ResolvedRef } from "../grounding/CitationChip";
import { formatPageLabel } from "../pageLabels";
import { HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import { flowText, studyAnnotationRows, type AnnotationKind, type AnnotationRow, type AnnotationSection } from "../annotations/model";
import AnnotationsPanel from "./AnnotationsPanel";

interface PdfAnnotationsPanelProps {
  highlights: CommentedHighlight[];
  pins: Pin[];
  panels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToHighlightId: string | null;
  onJumpToHighlight: (highlight: CommentedHighlight) => void;
  onDeleteHighlight: (highlight: CommentedHighlight) => void;
  onEditHighlightComment: (highlight: CommentedHighlight, comment: string) => void;
  onEditFreetextText: (highlight: CommentedHighlight, text: string) => void;
  onHoverHighlight: (highlightId: string | null) => void;
  onOpenDiveFromHighlight: (highlight: CommentedHighlight) => void;
  onJumpToSource: (ref: ResolvedRef) => void;
  onDeletePin: (pinId: string) => void;
  onEditPinComment: (pinId: string, comment: string) => void;
  onOpenDiveHighlight: (highlight: DiveHighlight) => void;
  onDeleteDiveHighlight: (highlightId: string) => void;
  onEditDiveHighlightComment: (highlightId: string, comment: string) => void;
  generalNotes: GeneralNote[];
  onAddNote: (text: string) => void;
  onEditGeneralNote: (id: string, text: string) => void;
  onDeleteGeneralNote: (id: string) => void;
  pageLabels: string[] | null;
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
}

export default function PdfAnnotationsPanel(props: PdfAnnotationsPanelProps) {
  // useDocumentOutline requires a non-null document, so the chapter lookup
  // only mounts (and only runs its hook) once PdfPane has reported one via
  // onDocumentReady — mirrors TableOfContentsPanel's own split for the same
  // reason.
  return props.pdfDocument ? (
    <PdfAnnotationsPanelWithOutline {...props} pdfDocument={props.pdfDocument} />
  ) : (
    <PdfAnnotationsPanelBody {...props} chapters={null} />
  );
}

// flatOutline flattens every level of the outline (chapters *and* their
// nested subsections) into one document-ordered list, so it's narrowed down
// to just the top-level entries (the lowest `level` present) — otherwise
// grouping and the "Current chapter" filter would work per subsection.
function PdfAnnotationsPanelWithOutline(props: PdfAnnotationsPanelProps & { pdfDocument: PDFDocumentProxy }) {
  const { flatOutline } = useDocumentOutline({ pdfDocument: props.pdfDocument });
  const chapters = useMemo(() => {
    if (!flatOutline || flatOutline.length === 0) return null;
    const minLevel = Math.min(...flatOutline.map((item) => item.level));
    return flatOutline
      .filter((item) => item.level === minLevel)
      .map((item) => ({ title: item.title, position: item.pageNumber }));
  }, [flatOutline]);
  return <PdfAnnotationsPanelBody {...props} chapters={chapters} />;
}

function PdfAnnotationsPanelBody({
  highlights,
  pins,
  panels,
  diveHighlights,
  scrolledToHighlightId,
  onJumpToHighlight,
  onDeleteHighlight,
  onEditHighlightComment,
  onEditFreetextText,
  onHoverHighlight,
  onOpenDiveFromHighlight,
  onJumpToSource,
  onDeletePin,
  onEditPinComment,
  onOpenDiveHighlight,
  onDeleteDiveHighlight,
  onEditDiveHighlightComment,
  generalNotes,
  onAddNote,
  onEditGeneralNote,
  onDeleteGeneralNote,
  pageLabels,
  currentPage,
  chapters,
}: PdfAnnotationsPanelProps & { chapters: AnnotationSection[] | null }) {
  const pageLabel = useCallback((position: number) => formatPageLabel(pageLabels, position), [pageLabels]);
  const positionLabel = useCallback((position: number) => `Page ${formatPageLabel(pageLabels, position)}`, [pageLabels]);
  const rows: AnnotationRow[] = useMemo(() => {
    const highlightRows = highlights.map((highlight, sourceIndex): AnnotationRow => {
      const kind: AnnotationKind =
        highlight.type === "freetext" ? "sticky" : highlight.type === "area" ? "area" : "highlight";
      const rect = highlight.position.boundingRect;
      const rawText = highlight.content?.text;
      const text = rawText && (kind === "sticky" ? rawText.trim() : flowText(rawText));
      const diveSummary = highlight.divePanelId ? panelById(panels, highlight.divePanelId)?.summary : undefined;
      return {
        id: highlight.id,
        kind,
        position: rect.pageNumber,
        locationLabel: `p. ${formatPageLabel(pageLabels, rect.pageNumber)}`,
        top: rect.height ? rect.y1 / rect.height : 0,
        createdAt: highlight.createdAt,
        sourceIndex,
        text: text || (kind === "sticky" ? "Empty sticky note" : kind === "area" ? "Area highlight" : "Highlight"),
        textIsPlaceholder: !text,
        image: kind === "area" ? highlight.content?.image : undefined,
        comment: highlight.comment,
        color: kind === "highlight" ? (highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0]) : undefined,
        isActive: scrolledToHighlightId === highlight.id,
        onOpen: () => onJumpToHighlight(highlight),
        onDelete: () => onDeleteHighlight(highlight),
        deleteWarning: highlight.divePanelId
          ? "This also deletes its deep dive conversation."
          : undefined,
        ...(kind === "sticky"
          ? { editsText: true, onEdit: (value: string) => onEditFreetextText(highlight, value) }
          : { onEdit: (comment: string) => onEditHighlightComment(highlight, comment) }),
        onHover: (hovered: boolean) => onHoverHighlight(hovered ? highlight.id : null),
        onOpenDive: highlight.divePanelId ? () => onOpenDiveFromHighlight(highlight) : undefined,
        diveSummary,
        diveSummaryNewAnswers:
          diveSummary && highlight.divePanelId
            ? treeAnswerCount(panels, highlight.divePanelId) - diveSummary.turnCount
            : undefined,
      };
    });

    // A dive highlight has no page of its own; it takes the page of the
    // main-text highlight its dive branch started from.
    const diveRows = diveHighlights.map((highlight, sourceIndex): AnnotationRow => {
      const root = rootPanelOf(panels, highlight.panelId);
      const anchorRect = root?.anchorHighlightId
        ? highlights.find((h) => h.id === root.anchorHighlightId)?.position.boundingRect
        : undefined;
      return {
        id: highlight.id,
        kind: "dive",
        position: anchorRect?.pageNumber,
        locationLabel: anchorRect ? `p. ${formatPageLabel(pageLabels, anchorRect.pageNumber)}` : undefined,
        top: anchorRect?.height ? anchorRect.y1 / anchorRect.height : 0,
        createdAt: highlight.createdAt,
        sourceIndex,
        text: flowText(highlight.text),
        comment: highlight.comment,
        color: highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0],
        context: panelById(panels, highlight.panelId)?.label ?? "a deep dive",
        isActive: false,
        onOpen: () => onOpenDiveHighlight(highlight),
        onDelete: () => onDeleteDiveHighlight(highlight.id),
        deleteWarning: highlight.divePanelId
          ? "This also deletes the dive started from it. This can't be undone."
          : "This can't be undone.",
        onEdit: (comment: string) => onEditDiveHighlightComment(highlight.id, comment),
      };
    });

    return [...highlightRows, ...diveRows, ...studyAnnotationRows({
      pins, notes: generalNotes, onDeletePin, onEditPin: onEditPinComment,
      onDeleteNote: onDeleteGeneralNote, onEditNote: onEditGeneralNote,
    })];
  }, [
    pageLabels,
    highlights,
    diveHighlights,
    pins,
    generalNotes,
    panels,
    scrolledToHighlightId,
    onJumpToHighlight,
    onDeleteHighlight,
    onEditHighlightComment,
    onEditFreetextText,
    onHoverHighlight,
    onOpenDiveFromHighlight,
    onOpenDiveHighlight,
    onDeleteDiveHighlight,
    onEditDiveHighlightComment,
    onDeletePin,
    onEditPinComment,
    onEditGeneralNote,
    onDeleteGeneralNote,
  ]);

  return <AnnotationsPanel
    rows={rows} sections={chapters} currentPosition={currentPage}
    positionLabel={positionLabel}
    pageLabel={pageLabel}
    onJumpToSource={onJumpToSource} onAddNote={onAddNote}
  />;
}
