import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ResolvedRef } from "./CitationChip";
import type { AnswerGrounding, SourceRef } from "./types";
import { sourceLabel } from "./citations";

const BADGES: Record<AnswerGrounding, { label: string; title: string }> = {
  document: { label: "Cites the document", title: "The answer cites passages supplied to the model; citations do not verify every claim." },
  inferred: {
    label: "Includes cited inference",
    title: "The answer marks some points as inferred from cited passages.",
  },
  mixed: {
    label: "Mixed sources",
    title: "The answer contains general knowledge or citations that could not be resolved — see the chips.",
  },
  general: { label: "No document citations", title: "The answer contains no valid document citations." },
  "not-covered": { label: "Not found in these passages", title: "The passages supplied did not answer this question." },
};

// One badge per answer, summarizing its citations — the same look as the
// glossary's source badge, so there's one vocabulary for "where did this
// come from".
export function AnswerBadge({ grounding }: { grounding: AnswerGrounding }) {
  const { label, title } = BADGES[grounding];
  return (
    <span className={`source-badge answer-badge answer-badge--${grounding}`} title={title}>
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
  const pages = [...new Set(cited.map((source) => sourceLabel(source, pageLabel)))];
  const summary = `${basis ?? `${sent.length} passage${sent.length === 1 ? "" : "s"} supplied`}${
    pages.length ? ` · cites ${pages.join(", ")}` : ""
  }`;
  return (
    <div className="answer-sources">
      <button
        type="button"
        className="answer-sources-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={cited.length === 0}
      >
        {cited.length > 0 ? open ? <ChevronDown width={13} height={13} /> : <ChevronRight width={13} height={13} /> : null}
        {summary}
      </button>
      {open ? (
        <ul className="answer-sources-list">
          {cited.map((source) => (
            <li key={source.label}>
              <button
                type="button"
                className="answer-sources-item"
                onClick={() => onJump({ source, range: [source.start, source.end] })}
                title="Show in the document"
              >
                <span className="cite-preview-page">{sourceLabel(source, pageLabel)}</span>
                <span className="answer-sources-snippet">
                  {source.text.length > 180 ? `${source.text.slice(0, 180)}…` : source.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
