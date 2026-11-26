import { useNotebook } from "../notebook/context";
import { saveDiveSummary } from "../notebook/capture";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import type { ResolvedRef } from "../grounding/CitationChip";
import { markersToPages } from "../grounding/citations";
import { treeRevision } from "./summary";
import type { DivePanel, SummaryJobState } from "./types";

// A dive tree's one-page summary (the treeSummary experiment), over the
// dive panes: made on first open, kept on the tree's root, and marked out of
// date once the tree has grown since.
export default function TreeSummaryPanel({
  root,
  panels,
  pageLabel,
  onJumpToSource,
  onSummarize,
  job,
  onCancel,
  onClose,
}: {
  root: DivePanel;
  panels: DivePanel[];
  pageLabel: (pageNumber: number) => string;
  onJumpToSource: (ref: ResolvedRef) => void;
  onSummarize: (rootId: string) => Promise<void>;
  job?: SummaryJobState;
  onCancel: () => void;
  onClose: () => void;
}) {
  const notebook = useNotebook();
  const [copied, setCopied] = useState(false);
  const started = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);

  const generate = async () => {
    await onSummarize(root.id);
  };

  // First open with nothing saved: make one.
  useEffect(() => {
    if (started.current || root.summary || job) return;
    started.current = true;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = root.summary;
  const stale = summary ? !summary.revision || summary.revision !== treeRevision(panels, root.id) : false;
  const busy = job?.phase === "streaming";
  const location = root.locationLabel || (root.pageNumber !== undefined ? `p. ${pageLabel(root.pageNumber)}` : "");

  const copy = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(markersToPages(summary.content, summary.sources, pageLabel));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: nothing to do.
    }
  };

  return (
    <div className="tree-summary" role="dialog" aria-label="Dive summary" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    }}>
      <header className="tree-summary-header">
        <div className="tree-summary-title">
          <div className="tree-summary-title-row">
            <h2 className="tree-summary-heading">Dive summary</h2>
            {location ? <span className="tree-summary-location">{location}</span> : null}
          </div>
          <span className="tree-summary-passage">{root.label || "Selected region"}</span>
        </div>
        <button type="button" ref={closeButton} className="tree-summary-close" onClick={onClose} aria-label="Close summary" title="Close summary">
          <X width={16} height={16} aria-hidden />
        </button>
      </header>
      {!busy && summary && stale ? (
        <p className="tree-summary-stale">
          The dive has changed since this summary. Update it to include the latest exploration.
        </p>
      ) : null}
      {summary ? <p className="tree-summary-stale">Created {new Date(summary.at).toLocaleString()}</p> : null}
      {job?.error ? <p className="tree-summary-error" role="status">{job.error}</p> : null}
      <div className="tree-summary-body">
        {busy ? (
          job.text ? (
            <AnswerMarkdown content={job.text} sources={job.sources} pageLabel={pageLabel} onJump={onJumpToSource} streaming />
          ) : (
            <span className="dive-thinking">Reading the dive…</span>
          )
        ) : summary ? (
          <AnswerMarkdown content={summary.content} sources={summary.sources} pageLabel={pageLabel} onJump={onJumpToSource} />
        ) : null}
      </div>
      <footer className="tree-summary-actions">
        {busy ? (
          <><span className="tree-summary-progress" role="status">Summarizing…</span><button type="button" className="answer-more" onClick={onCancel}>Stop</button></>
        ) : (
          <>
            <button type="button" className="answer-more" onClick={() => void generate()}>{summary ? "Update" : "Summarize"}</button>
            {summary ? <button type="button" className="answer-more" onClick={() => void copy()}>{copied ? "Copied" : "Copy as Markdown"}</button> : null}
            {summary && notebook ? <button type="button" className="tree-summary-save" onClick={() => void saveDiveSummary(notebook.store, root, summary)}>Add to notebook</button> : null}
          </>
        )}
      </footer>
    </div>
  );
}
