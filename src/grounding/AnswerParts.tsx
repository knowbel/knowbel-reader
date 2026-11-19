import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ResolvedRef } from "./CitationChip";
import type { AnswerGrounding, SourceRef } from "./types";
import { citationNumber, sourceLabel } from "./citations";

const BADGES: Record<Exclude<AnswerGrounding, "document">, { label: string; title: string }> = {
  inferred: {
    label: "Includes cited inference",
    title: "The answer marks some points as inferred from cited passages.",
  },
  mixed: {
    label: "Mixed sources",
    title: "The answer includes general knowledge, unresolved citations, or quotes that could not be matched. See the inline references.",
  },
  general: { label: "No document citations", title: "The answer contains no valid document citations." },
  "not-covered": { label: "Not found in these passages", title: "The passages supplied did not answer this question." },
};

export function AnswerBadge({ grounding }: { grounding: AnswerGrounding }) {
  if (grounding === "document") return null;
  const { label, title } = BADGES[grounding];
  return (
    <span className="answer-badge" title={title}>
      {label}
    </span>
  );
}

// What the answer rests on: how many passages were read, and the ones it
// cited, each a jump into the PDF. Collapsed by default.
export function SourcesFooter({
  sent,
  cited,
  pageLabel,
  onJump,
  summary: basis,
}: {
  sent: SourceRef[];
  cited: SourceRef[];
  pageLabel: (pageNumber: number) => string;
  onJump: (ref: ResolvedRef) => void;
  summary?: string; // what was read, when it's more telling than a count ("Based on all of Chapter 3")
}) {
  const [open, setOpen] = useState(false);
  if (sent.length === 0) return null;
  const summary = basis ?? `${sent.length} passage${sent.length === 1 ? "" : "s"} supplied`;
  if (cited.length === 0) return <div className="answer-sources">{summary}</div>;
  return (
    <div className="answer-sources">
      <button
        type="button"
        className="answer-sources-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown width={13} height={13} /> : <ChevronRight width={13} height={13} />}
        Sources ({cited.length})
      </button>
      {open ? (
        <>
          <div className="answer-sources-basis">{summary}</div>
          <ul className="answer-sources-list">
            {cited.map((source) => (
              <li key={source.label}>
                <button
                  type="button"
                  className="answer-sources-item"
                  onClick={() => onJump({ source, range: [source.start, source.end] })}
                  title="Show in the document"
                >
                  <span className="cite-preview-page">[{citationNumber(source)}] {sourceLabel(source, pageLabel)}</span>
                  <span className="answer-sources-snippet">
                    {source.text.length > 180 ? `${source.text.slice(0, 180)}…` : source.text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
