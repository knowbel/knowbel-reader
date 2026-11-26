import { useRef, useState, type RefObject } from "react";
import { FileText } from "lucide-react";
import type { DiveHighlight, DiveHighlightPlacement, DivePanel, DiveJobState, DiveTurnRequest, SummaryJobState } from "./types";
import type { Attachment } from "../grounding/attachments";
import { ancestorChain, paneWindow, panelById } from "./tree";
import DivePanelPane, { type DivePanelPaneProps } from "./DivePanelPane";
import { useExperiments } from "./experiments";
import DiveMap from "./DiveMap";
import TreeSummaryPanel from "./TreeSummaryPanel";
import GuidedDiveView from "./GuidedDiveView";
import { guidedRoot, type GuidedQuestionRequest } from "./guided";

export interface DeepDiveViewProps {
  panels: DivePanel[];
  jobs: Record<string, DiveJobState>;
  summaryJobs: Record<string, SummaryJobState>;
  onCancelSummary: (rootId: string) => void;
  onCancel: (panelId: string) => void;
  onReturnToPassage: DivePanelPaneProps["onReturnToPassage"];
  scrollPositions: Map<string, number>;
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  focusId: string;
  turnRequest?: DiveTurnRequest;
  rootLabel: string;
  onFocusChange: (id: string | null) => void;
  rootSlotRef: RefObject<HTMLDivElement>;
  onSendMessage: DivePanelPaneProps["onSendMessage"];
  onCreateGuidedQuestion: (request: GuidedQuestionRequest) => string | undefined;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string } & DiveHighlightPlacement) => void;
  onSuggestedDive: DivePanelPaneProps["onSuggestedDive"];
  onSummarizeTree: (rootId: string) => Promise<void>;
  pageLabel: DivePanelPaneProps["pageLabel"];
  onJumpToSource: DivePanelPaneProps["onJumpToSource"];
  attachments: Record<string, Attachment[]>; // per dive
  onAddToQuestion: (divePanelId: string, kind: Attachment["kind"], text: string, pageNumber?: number) => void;
  onRemoveAttachment: (divePanelId: string, id: string) => void;
  onClearAttachments: (divePanelId: string) => void;
  onAddHighlight: (
    panelId: string,
    text: string,
    comment: string,
    style?: Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "divePanelId"> & DiveHighlightPlacement,
  ) => string;
  onEditHighlight: (
    highlightId: string,
    edit: Partial<Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "comment" | "divePanelId">>,
  ) => void;
  onDeleteHighlight: (highlightId: string) => void;
  onDiveFromHighlight: (highlight: DiveHighlight, contextText: string) => void;
  onPin: (selection: string, contextText: string) => void;
}

const NO_ATTACHMENTS: Attachment[] = [];

export default function DeepDiveView(props: DeepDiveViewProps) {
  const {
    panels,
    jobs,
    summaryJobs,
    onCancelSummary,
    onCancel,
    onReturnToPassage,
    scrollPositions,
    diveHighlights,
    scrolledToDiveHighlightId,
    focusId,
    rootLabel,
    onFocusChange,
    rootSlotRef,
    onSendMessage,
    onNestedDive,
    onSuggestedDive,
    onSummarizeTree,
    pageLabel,
    onJumpToSource,
    attachments,
    onAddToQuestion,
    onRemoveAttachment,
    onClearAttachments,
    onAddHighlight,
    onEditHighlight,
    onDeleteHighlight,
    onDiveFromHighlight,
    onPin,
  } = props;
  const experiments = useExperiments();
  const [summaryOpenFor, setSummaryOpenFor] = useState<string | null>(null);
  const summaryToggle = useRef<HTMLButtonElement>(null);
  const chain = ancestorChain(panels, focusId, rootLabel);
  const paneEntries = paneWindow(chain);
  // The dive this tree started from (chain[0] is the PDF itself).
  const root = chain[1]?.id ? panelById(panels, chain[1].id) : null;
  const paneProps = (id: string): DivePanelPaneProps => ({
    panel: panelById(panels, id)!,
    job: jobs[id],
    onCancel,
    onReturnToPassage,
    scrollPositions,
    allPanels: panels,
    diveHighlights,
    scrolledToDiveHighlightId,
    focusedPanelId: focusId,
    onOpenDive: onFocusChange,
    onSendMessage,
    onNestedDive,
    onSuggestedDive,
    pageLabel,
    onJumpToSource,
    attachments: attachments[id] ?? NO_ATTACHMENTS,
    onAddToQuestion: (kind, text, pageNumber) => onAddToQuestion(id, kind, text, pageNumber),
    onRemoveAttachment: (attachmentId) => onRemoveAttachment(id, attachmentId),
    onClearAttachments: () => onClearAttachments(id),
    onAddHighlight,
    onEditHighlight,
    onDeleteHighlight,
    onDiveFromHighlight,
    onPin,
  });
  const guide = experiments.guidedQuestions ? guidedRoot(panels, focusId) : null;
  if (guide) return <GuidedDiveView {...props} guide={guide} paneProps={paneProps} diagrams={experiments.diagrams} treeSummary={experiments.treeSummary} />;

  return (
    <div className="deep-dive-view">
      <nav className="deep-dive-breadcrumb">
        {chain.map((entry, index) => (
          <span key={entry.id ?? "root"} className="deep-dive-crumb-group">
            <button
              type="button"
              className={`deep-dive-crumb${index === chain.length - 1 ? " current" : ""}`}
              onClick={() => onFocusChange(entry.id)}
            >
              {entry.label}
            </button>
            {index < chain.length - 1 ? <span className="deep-dive-crumb-sep">›</span> : null}
          </span>
        ))}
        {root && (experiments.diveMap || experiments.treeSummary) ? (
          <span className="deep-dive-tools">
            {experiments.diveMap ? (
              <DiveMap panels={panels} rootId={root.id} focusId={focusId} onFocus={onFocusChange} pageLabel={pageLabel} />
            ) : null}
            {experiments.treeSummary ? (
              <span className="deep-dive-tool">
                <button
                  type="button"
                  ref={summaryToggle}
                  className={`deep-dive-tool-button${summaryOpenFor === root.id ? " active" : ""}`}
                  aria-expanded={summaryOpenFor === root.id}
                  onClick={() => setSummaryOpenFor((open) => (open === root.id ? null : root.id))}
                  title="A one-page summary of every dive from this passage"
                >
                  <FileText width={14} height={14} aria-hidden="true" />
                  Summary
                </button>
              </span>
            ) : null}
          </span>
        ) : null}
      </nav>
      {experiments.treeSummary && root && summaryOpenFor === root.id ? (
        <TreeSummaryPanel
          key={root.id}
          root={root}
          panels={panels}
          pageLabel={pageLabel}
          onJumpToSource={onJumpToSource}
          onSummarize={onSummarizeTree}
          job={summaryJobs[root.id]}
          onCancel={() => onCancelSummary(root.id)}
          onClose={() => {
            setSummaryOpenFor(null);
            summaryToggle.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <div className="deep-dive-panes">
        {paneEntries.map((entry) => (
          <div className="deep-dive-pane" key={entry.id ?? "root"}>
            {entry.id === null ? (
              <div className="pdf-pane-slot" ref={rootSlotRef} />
            ) : (
              <DivePanelPane {...paneProps(entry.id)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
