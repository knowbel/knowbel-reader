import { useEffect, useRef, useState } from "react";
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
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

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
    <div className="tree-summary" role="dialog" aria-label="Dive summary">
      <header className="tree-summary-header">
        <div className="tree-summary-title">
          <span className="tree-summary-kicker">Summary{root.pageNumber !== undefined ? ` · p. ${pageLabel(root.pageNumber)}` : ""}</span>
          <span className="tree-summary-passage">{root.label || "Selected region"}</span>
        </div>
        <div className="tree-summary-actions">
          {summary && !busy ? (
            <button type="button" className="answer-more" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          ) : null}
          <button type="button" className="answer-more" onClick={() => void generate()} disabled={busy}>
            {busy ? "Summarizing…" : summary ? "Update" : "Summarize"}
          </button>
          {busy ? <button type="button" className="answer-more" onClick={onCancel}>Stop</button> : null}
          <button type="button" className="tree-summary-close" onClick={onClose} aria-label="Close summary" title="Close">
            <X width={16} height={16} />
          </button>
        </div>
      </header>
      {!busy && summary && stale ? (
        <p className="tree-summary-stale">
          The dive has changed since this summary. Update it to include the latest exploration.
        </p>
      ) : null}
      {summary ? <p className="tree-summary-stale">Created {new Date(summary.at).toLocaleString()}</p> : null}
      {job?.error ? <p className="tree-summary-error">{job.error}</p> : null}
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
    </div>
  );
}
