import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ReaderNavigator from "./ReaderNavigator";
import { formatPageLabel, pageNumberForInput } from "../pageLabels";
import type { ReadingPlace } from "./history";

interface PageNavigatorProps {
  currentPage: number;
  numPages: number;
  pageLabels: string[] | null;
  twoPageView: boolean;
  // Nearest first: the first is where one step goes.
  back: ReadingPlace[];
  forward: ReadingPlace[];
  onBack: (steps: number) => void;
  onForward: (steps: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGoToPage: (pageNumber: number) => void;
  // Bumped by ⌥⌘G: put the cursor in the page number.
  focusRequest: number;
}

// Where the reader is in the document, and the ways to move: the previous
// or next page, a typed page number, and Back/Forward over earlier jumps.
// Floats at the bottom of the PDF pane (so it follows the pane into Deep
// Dive), shown while the reader scrolls or turns pages and faded out a
// moment after.
export default function PageNavigator({
  currentPage,
  numPages,
  pageLabels,
  twoPageView,
  back,
  forward,
  onBack,
  onForward,
  onPreviousPage,
  onNextPage,
  onGoToPage,
  focusRequest,
}: PageNavigatorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  // In two-page view pdf.js pairs pages 1–2, 3–4, …
  const firstShown = twoPageView && currentPage % 2 === 0 ? currentPage - 1 : currentPage;
  const lastShown = twoPageView ? Math.min(firstShown + 1, numPages) : firstShown;
  const label = formatPageLabel(pageLabels, firstShown);
  const labelled = Boolean(pageLabels) && label !== String(firstShown);
  const range = lastShown > firstShown ? `${firstShown}–${lastShown}` : String(firstShown);
  const total = labelled ? `(${range} / ${numPages})` : `${lastShown > firstShown ? `–${lastShown} ` : ""}/ ${numPages}`;

  // Wide enough for the longest label, so the control doesn't change width
  // from page to page.
  const inputChars = useMemo(() => {
    const longest = pageLabels ? Math.max(...pageLabels.map((l) => l.length)) : 0;
    return Math.max(2, longest, String(numPages).length);
  }, [pageLabels, numPages]);

  const submit = () => {
    const pageNumber = pageNumberForInput(pageLabels, draft ?? "", numPages);
    if (pageNumber === null) {
      setInvalid(true);
      return;
    }
    onGoToPage(pageNumber);
    inputRef.current?.blur();
  };

  return (
    <ReaderNavigator
      ariaLabel="Page navigation"
      locationKey={currentPage}
      locationLabel={`p. ${formatPageLabel(pageLabels, currentPage)}`}
      back={back}
      forward={forward}
      placeLabel={(place) => `p. ${formatPageLabel(pageLabels, place.pageNumber)}`}
      onBack={onBack}
      onForward={onForward}
      focusRequest={focusRequest}
    >
      <button
        type="button"
        className="page-nav-button"
        onClick={onPreviousPage}
        disabled={firstShown <= 1}
        title="Previous page (←)"
        aria-label="Previous page"
      >
        <ChevronLeft width={16} height={16} aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        data-navigation-location
        className="page-nav-input"
        style={{ width: `calc(${inputChars}ch + 12px)` }}
        value={draft ?? label}
        aria-label="Page number"
        aria-invalid={invalid}
        title="Go to page (⌥⌘G)"
        inputMode="text"
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => {
          setDraft(label);
          event.target.select();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            inputRef.current?.blur();
          }
        }}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
      />
      <span className="page-nav-total">{total}</span>
      <button
        type="button"
        className="page-nav-button"
        onClick={onNextPage}
        disabled={lastShown >= numPages}
        title="Next page (→)"
        aria-label="Next page"
      >
        <ChevronRight width={16} height={16} aria-hidden="true" />
      </button>
    </ReaderNavigator>
  );
}
