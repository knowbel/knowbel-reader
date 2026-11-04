import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { showNotice } from "./notices";
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Copy,
  CornerDownRight,
  FileText,
  Funnel,
  Highlighter,
  MessagesSquare,
  NotebookPen,
  Pencil,
  Pin as PinIcon,
  Plus,
  Search,
  SquareDashed,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import type { ResolvedRef } from "../grounding/CitationChip";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import { annotationRangeAt, groupAnnotationRows, type AnnotationKind, type AnnotationRow, type AnnotationSection, type AnnotationSort, type AnnotationGroup } from "../annotations/model";

interface AnnotationsPanelProps {
  rows: AnnotationRow[];
  sections: AnnotationSection[] | null;
  currentPosition: number;
  positionLabel: (position: number) => string;
  pageLabel?: (position: number) => string;
  onJumpToSource: (ref: ResolvedRef) => void;
  onAddNote: (text: string) => void;
  editRequestId?: string | null;
  onEditRequestHandled?: () => void;
}

const KINDS: { key: AnnotationKind; label: string; filterLabel: string; Icon: LucideIcon }[] = [
  { key: "highlight", label: "Highlight", filterLabel: "Highlights", Icon: Highlighter },
  { key: "area", label: "Area", filterLabel: "Area highlights", Icon: SquareDashed },
  { key: "sticky", label: "Sticky note", filterLabel: "Sticky notes", Icon: StickyNote },
  { key: "dive", label: "Dive highlight", filterLabel: "Deep-dive highlights", Icon: MessagesSquare },
  { key: "pin", label: "Pin", filterLabel: "Pins", Icon: PinIcon },
  { key: "note", label: "Note", filterLabel: "General notes", Icon: NotebookPen },
];

const KIND_BY_KEY = Object.fromEntries(KINDS.map((kind) => [kind.key, kind])) as Record<
  AnnotationKind,
  (typeof KINDS)[number]
>;

// Rows whose body is the reader's own words rather than a quoted passage.
const OWN_TEXT_KINDS = new Set<AnnotationKind>(["sticky", "note"]);

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_SHORTCUT = IS_MAC ? "⌘↵" : "Ctrl+↵";

interface Filters {
  kinds: AnnotationKind[];
  colors: string[];
  withNotes: boolean;
  nearby: boolean;
}

const NO_FILTERS: Filters = { kinds: [], colors: [], withNotes: false, nearby: false };

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAnyTerm(text: string | undefined, terms: string[]): boolean {
  if (!text || terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

// Wraps every occurrence of a search term in <mark>.
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi"));
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}</>;
}

// "$$tex$$" or "$tex$" — how deepdive/selectionText.ts stores each equation
// in a dive highlight's text.
const TEX_SPAN = /\$\$([^$]+?)\$\$|\$([^$]+?)\$/g;

function renderTex(tex: string): string | null {
  try {
    return katex.renderToString(tex, { throwOnError: true, displayMode: false });
  } catch {
    return null;
  }
}

// Like Highlighted, but renders each "$tex$" span with KaTeX (inline, to
// flow with the card's text). One that doesn't parse stays as written.
function WithMath({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    const result: ({ text: string } | { html: string })[] = [];
    let last = 0;
    for (const match of text.matchAll(TEX_SPAN)) {
      const html = renderTex(match[1] ?? match[2]);
      if (html == null) continue;
      if (match.index > last) result.push({ text: text.slice(last, match.index) });
      result.push({ html });
      last = match.index + match[0].length;
    }
    if (last < text.length) result.push({ text: text.slice(last) });
    return result;
  }, [text]);
  return (
    <>
      {parts.map((part, index) =>
        "html" in part ? (
          <span key={index} className="annot-math" dangerouslySetInnerHTML={{ __html: part.html }} />
        ) : (
          <Highlighted key={index} text={part.text} terms={terms} />
        ),
      )}
    </>
  );
}

// Clamps `text` to `lines` lines, with a Show more/less toggle that only
// appears when there's actually more to show. While a search term is inside
// it, it shows everything (so the match isn't hidden) and hides the toggle.
function ClampedText({
  className,
  lines,
  text,
  terms,
  math = false,
}: {
  className: string;
  lines: number;
  text: string;
  terms: string[];
  math?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const forceExpanded = containsAnyTerm(text, terms);
  const open = expanded || forceExpanded;

  // Only measurable while clamped; once expanded the last reading stands so
  // the "Show less" toggle stays.
  useLayoutEffect(() => {
    const element = ref.current;
    if (open || !element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <>
      <div
        ref={ref}
        className={`${className} annot-clamp${open ? " is-expanded" : ""}`}
        style={{ "--annot-clamp-lines": lines } as CSSProperties}
      >
        {math ? <WithMath text={text} terms={terms} /> : <Highlighted text={text} terms={terms} />}
      </div>
      {overflowing && !forceExpanded ? (
        <button
          type="button"
          className="annot-more"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [props.value]);

  // An autofocused note starts with the caret at the end, so editing an
  // existing note continues it.
  useEffect(() => {
    const element = ref.current;
    if (!element || document.activeElement !== element) return;
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  return <textarea ref={ref} rows={2} {...props} />;
}

// The inline editor for a note: a row's attached note, a sticky note's or
// general note's own text, or a brand new general note.
function NoteEditor({
  initialValue,
  placeholder,
  allowEmpty,
  onSave,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  allowEmpty: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const canSave = allowEmpty || Boolean(draft.trim());
  const save = () => {
    if (canSave) onSave(draft.trim());
  };

  return (
    <div className="annot-editor" onClick={(event) => event.stopPropagation()}>
      <AutoGrowTextarea
        className="annot-editor-textarea"
        aria-label="Note text"
        value={draft}
        autoFocus
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="annot-editor-footer">
        <span className="annot-editor-hint">
          {SAVE_SHORTCUT} to save · Esc to cancel
        </span>
        <button type="button" className="annot-button annot-button--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="annot-button annot-button--primary" onClick={save} disabled={!canSave}>
          Save
        </button>
      </div>
    </div>
  );
}

// Runs `onOutside` on a mousedown outside `ref` or an Escape keypress, while
// `active` — for dismissing menus and pending confirmations.
function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutsideRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOutsideRef.current();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, active]);
}

// Shows a check mark for a moment after a successful copy.
function useCopyFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => showNotice("Couldn't copy to the clipboard."));
  };
  return [copied, copy];
}

function locationSuffix(row: AnnotationRow): string {
  return row.locationLabel ?? "";
}

function rowAsText(row: AnnotationRow): string {
  const location = locationSuffix(row);
  const body = row.textIsPlaceholder
    ? `[${row.text}]`
    : OWN_TEXT_KINDS.has(row.kind)
      ? row.text
      : `“${row.text}”`;
  const lines = [location ? `${body} (${location})` : body];
  if (row.comment) lines.push(`Note: ${row.comment}`);
  return lines.join("\n");
}

function groupsAsMarkdown(groups: AnnotationGroup[]): string {
  const indent = (text: string) => text.replace(/\n/g, "\n  ");
  return groups
    .map((group) => {
      const items = group.rows.map((row) => {
        const lines = rowAsText(row).split("\nNote: ");
        const item = `- ${KIND_BY_KEY[row.kind].label}: ${indent(lines[0])}`;
        return lines[1] ? `${item}\n  - Note: ${indent(indent(lines[1]))}` : item;
      });
      return [`## ${group.title}`, "", ...items].join("\n");
    })
    .join("\n\n");
}

function AnnotationCard({
  row,
  terms,
  showLocation,
  pageLabel,
  editRequested,
  onEditRequestHandled,
  onJumpToSource,
}: {
  row: AnnotationRow;
  terms: string[];
  showLocation: boolean;
  pageLabel: (position: number) => string;
  editRequested: boolean;
  onEditRequestHandled?: () => void;
  onJumpToSource: (ref: ResolvedRef) => void;
}) {
  const editsText = Boolean(row.editsText);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editRequested) return;
    setEditing(true);
    cardRef.current?.scrollIntoView({ block: "nearest" });
    onEditRequestHandled?.();
  }, [editRequested, onEditRequestHandled]);
  const [showingSummary, setShowingSummary] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, copy] = useCopyFeedback();
  const cardRef = useRef<HTMLElement>(null);
  useDismiss(cardRef, confirmingDelete, () => setConfirmingDelete(false));

  // A row deleted (or filtered out) while hovered never gets mouseleave, so
  // clear the reader hover feedback when it unmounts instead.
  const hoveredRef = useRef(false);
  const onHoverRef = useRef(row.onHover);
  onHoverRef.current = row.onHover;
  useEffect(
    () => () => {
      if (hoveredRef.current) onHoverRef.current?.(false);
    },
    [],
  );
  const setHovered = (hovered: boolean) => {
    hoveredRef.current = hovered;
    row.onHover?.(hovered);
  };

  useEffect(() => {
    if (row.isActive) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [row.isActive]);

  const save = (value: string) => {
    const current = editsText ? row.text : (row.comment ?? "");
    if ((value || !editsText) && value !== current) row.onEdit(value);
    setEditing(false);
  };

  const { Icon, label } = KIND_BY_KEY[row.kind];
  const editLabel = editsText || row.comment ? "Edit note" : "Add note";
  // While editing, the card body is static so clicks inside the editor
  // don't also jump to the annotation. A general note has nowhere to jump
  // to, so clicking it starts editing instead.
  const onOpen = editing ? undefined : row.kind === "note" ? () => setEditing(true) : row.onOpen;
  const location = showLocation ? locationSuffix(row) : "";

  const editor = editing ? (
    <NoteEditor
      initialValue={editsText ? (row.textIsPlaceholder ? "" : row.text) : (row.comment ?? "")}
      placeholder={editsText ? "Write a note…" : "Add a note about this…"}
      allowEmpty={!editsText}
      onSave={save}
      onCancel={() => setEditing(false)}
    />
  ) : null;

  return (
    <article
      ref={cardRef}
      className={`annot-card annot-card--${row.kind}${row.isActive ? " is-active" : ""}${
        row.color ? " has-color" : ""
      }${confirmingDelete ? " is-confirming" : ""}`}
      style={row.color ? ({ "--annot-color": row.color } as CSSProperties) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`annot-card-body${onOpen ? " is-clickable" : ""}`}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        title={onOpen && row.kind !== "note" ? (row.kind === "dive" ? "Open in its dive" : "Go to annotation") : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          // Only the card itself — Enter on a button inside it is that
          // button's own click.
          if (!onOpen || event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="annot-card-meta">
          <Icon className="annot-card-icon" width={13} height={13} strokeWidth={2} aria-hidden="true" />
          <span>{label}</span>
          {location ? <span className="annot-card-location" title={location}>· {location}</span> : null}
          {row.onOpenDive ? (
            <button
              type="button"
              className="annot-dive-link"
              title="Open its deep dive"
              onClick={(event) => {
                event.stopPropagation();
                row.onOpenDive!();
              }}
            >
              <MessagesSquare width={11} height={11} strokeWidth={2.25} aria-hidden="true" />
              Dive
            </button>
          ) : null}
          {row.diveSummary ? (
            <button
              type="button"
              className={`annot-dive-link${showingSummary ? " is-open" : ""}`}
              title={showingSummary ? "Hide its dive summary" : "Show its dive summary"}
              aria-expanded={showingSummary}
              onClick={(event) => {
                event.stopPropagation();
                setShowingSummary((open) => !open);
              }}
            >
              <FileText width={11} height={11} strokeWidth={2.25} aria-hidden="true" />
              Summary
            </button>
          ) : null}
        </div>

        {row.context ? (
          <div className="annot-card-context" title={row.context}>
            <CornerDownRight width={12} height={12} aria-hidden="true" />
            <span>in “{row.context}”</span>
          </div>
        ) : null}

        {row.image ? <img className="annot-card-image" src={row.image} alt="" /> : null}

        {editing && editsText ? (
          editor
        ) : row.textIsPlaceholder ? (
          // Only when there's nothing else to show in the card.
          row.image || row.comment ? null : <div className="annot-card-placeholder">{row.text}</div>
        ) : (
          <ClampedText
            className={`annot-card-text${OWN_TEXT_KINDS.has(row.kind) ? " is-own" : " is-quote"}`}
            lines={OWN_TEXT_KINDS.has(row.kind) ? 6 : 4}
            text={row.text}
            terms={terms}
            math={row.kind === "dive"}
          />
        )}

        {editing && !editsText ? (
          editor
        ) : row.comment ? (
          <div className="annot-card-comment">
            <ClampedText className="annot-card-comment-text" lines={4} text={row.comment} terms={terms} />
          </div>
        ) : null}

        {showingSummary && row.diveSummary ? (
          // Its citation chips jump to their own passages, not the card's.
          <div className="annot-card-summary" onClick={(event) => event.stopPropagation()}>
            {row.diveSummaryNewAnswers ? (
              <p className="annot-card-summary-stale">
                {row.diveSummaryNewAnswers} new answer{row.diveSummaryNewAnswers === 1 ? "" : "s"} since this summary —
                update it from the dive.
              </p>
            ) : null}
            <AnswerMarkdown
              content={row.diveSummary.content}
              sources={row.diveSummary.sources}
              pageLabel={pageLabel}
              onJump={onJumpToSource}
            />
          </div>
        ) : null}
      </div>

      {confirmingDelete ? (
        <div className="annot-confirm" role="alertdialog" aria-label="Confirm delete">
          <span className="annot-confirm-text">
            Delete this {label.toLowerCase()}? {row.deleteWarning}
          </span>
          <button type="button" className="annot-button annot-button--quiet" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
          <button type="button" className="annot-button annot-button--danger" autoFocus onClick={row.onDelete}>
            Delete
          </button>
        </div>
      ) : (
        <div className="annot-card-actions">
          {!row.textIsPlaceholder || row.comment ? (
            <button
              type="button"
              className="annot-card-action"
              title={copied ? "Copied" : "Copy"}
              aria-label="Copy"
              onClick={() => copy(rowAsText(row))}
            >
              {copied ? <Check width={14} height={14} strokeWidth={2} /> : <Copy width={14} height={14} strokeWidth={2} />}
            </button>
          ) : null}
          {!editing ? (
            <button
              type="button"
              className="annot-card-action"
              title={editLabel}
              aria-label={editLabel}
              onClick={() => setEditing(true)}
            >
              <Pencil width={14} height={14} strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            className="annot-card-action annot-card-action--danger"
            title={row.deleteWarning ? "Delete…" : "Delete (⌘Z to undo)"}
            aria-label="Delete"
            onClick={() => (row.deleteWarning ? setConfirmingDelete(true) : row.onDelete())}
          >
            <Trash2 width={14} height={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </article>
  );
}

function FiltersMenu({
  filters,
  onChange,
  kindCounts,
  colorsInUse,
  nearbyLabel,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  kindCounts: Record<AnnotationKind, number>;
  colorsInUse: string[];
  nearbyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(containerRef, open, () => setOpen(false));
  const activeCount =
    filters.kinds.length + filters.colors.length + Number(filters.withNotes) + Number(filters.nearby);

  return (
    <div className="annot-filters" ref={containerRef}>
      <button
        type="button"
        className={`annot-toolbar-button${activeCount > 0 ? " is-active" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        <Funnel width={13} height={13} strokeWidth={2.25} aria-hidden="true" />
        Filter
        {activeCount > 0 ? <span className="annot-filters-count">{activeCount}</span> : null}
        <ChevronDown className="annot-filters-chevron" width={13} height={13} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {open ? (
        <div className="annot-filters-menu">
          <p className="annot-filters-heading">Type</p>
          {KINDS.map(({ key, filterLabel, Icon }) => (
            <label key={key} className={`annot-filters-item${kindCounts[key] === 0 ? " is-empty" : ""}`}>
              <input
                type="checkbox"
                checked={filters.kinds.includes(key)}
                onChange={() => onChange({ ...filters, kinds: toggled(filters.kinds, key) })}
              />
              <Icon width={13} height={13} strokeWidth={2} aria-hidden="true" />
              <span className="annot-filters-item-label">{filterLabel}</span>
              <span className="annot-filters-item-count">{kindCounts[key]}</span>
            </label>
          ))}

          {colorsInUse.length > 1 ? (
            <>
              <p className="annot-filters-heading">Color</p>
              <div className="annot-filters-swatches">
                {colorsInUse.map((color) => {
                  const selected = filters.colors.includes(color);
                  const name = HIGHLIGHT_COLOR_NAMES[color] ?? "Custom";
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`annot-swatch${selected ? " is-selected" : ""}`}
                      style={{ background: color }}
                      title={name}
                      aria-label={name}
                      aria-pressed={selected}
                      onClick={() => onChange({ ...filters, colors: toggled(filters.colors, color) })}
                    >
                      {selected ? <Check width={12} height={12} strokeWidth={3} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          <p className="annot-filters-heading">Show only</p>
          <label className="annot-filters-item">
            <input
              type="checkbox"
              checked={filters.withNotes}
              onChange={() => onChange({ ...filters, withNotes: !filters.withNotes })}
            />
            <span className="annot-filters-item-label">With a note</span>
          </label>
          <label className="annot-filters-item">
            <input
              type="checkbox"
              checked={filters.nearby}
              onChange={() => onChange({ ...filters, nearby: !filters.nearby })}
            />
            <span className="annot-filters-item-label">{nearbyLabel}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

export default function AnnotationsPanel({
  rows, sections, currentPosition, positionLabel,
  pageLabel = String, onJumpToSource, onAddNote, editRequestId, onEditRequestHandled,
}: AnnotationsPanelProps) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<AnnotationSort>("document");
  const [composing, setComposing] = useState(false);
  const [copiedAll, copyAll] = useCopyFeedback();
  const searchRef = useRef<HTMLInputElement>(null);

  const kindCounts = useMemo(() => {
    const counts = Object.fromEntries(KINDS.map(({ key }) => [key, 0])) as Record<AnnotationKind, number>;
    rows.forEach((row) => counts[row.kind]++);
    return counts;
  }, [rows]);

  const colorsInUse = useMemo(() => {
    const used = new Set(rows.map((row) => row.color).filter((color): color is string => Boolean(color)));
    // Presets in their menu order, then any others.
    return [...HIGHLIGHT_COLOR_PRESETS.filter((color) => used.has(color)), ...[...used].filter((color) => !HIGHLIGHT_COLOR_PRESETS.includes(color))];
  }, [rows]);

  const sectionRange = useMemo(() => annotationRangeAt(sections, currentPosition), [sections, currentPosition]);
  const [nearbyStart, nearbyEnd] = sectionRange ?? [currentPosition, currentPosition];

  useEffect(() => {
    if (!editRequestId) return;
    setFilters(NO_FILTERS);
    setQuery("");
  }, [editRequestId]);

  const terms = useMemo(() => searchTerms(query), [query]);

  // Types OR together (a row is only ever one type); every other kind of
  // filter, and each search term, must also match.
  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (filters.kinds.length > 0 && !filters.kinds.includes(row.kind)) return false;
        if (filters.colors.length > 0 && (!row.color || !filters.colors.includes(row.color))) return false;
        if (filters.withNotes && !row.comment && !OWN_TEXT_KINDS.has(row.kind)) return false;
        if (filters.nearby) {
          if (row.position == null || row.position < nearbyStart || row.position > nearbyEnd) return false;
        }
        if (terms.length > 0) {
          const haystack = [
            row.textIsPlaceholder ? "" : row.text,
            row.comment,
            row.context,
            KIND_BY_KEY[row.kind].label,
            locationSuffix(row),
          ]
            .join("\n")
            .toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) return false;
        }
        return true;
      }),
    [rows, filters, nearbyStart, nearbyEnd, terms],
  );

  const groups = useMemo(
    () => groupAnnotationRows(filteredRows, sort, sections, positionLabel),
    [filteredRows, sort, sections, positionLabel],
  );

  const activeChips: { key: string; label: ReactNode; remove: () => void }[] = [
    ...filters.kinds.map((kind) => ({
      key: `kind-${kind}`,
      label: KIND_BY_KEY[kind].filterLabel,
      remove: () => setFilters((f) => ({ ...f, kinds: f.kinds.filter((k) => k !== kind) })),
    })),
    ...filters.colors.map((color) => ({
      key: `color-${color}`,
      label: (
        <>
          <span className="annot-chip-swatch" style={{ background: color }} />
          {HIGHLIGHT_COLOR_NAMES[color] ?? "Custom"}
        </>
      ),
      remove: () => setFilters((f) => ({ ...f, colors: f.colors.filter((c) => c !== color) })),
    })),
    ...(filters.withNotes
      ? [{ key: "notes", label: "With a note", remove: () => setFilters((f) => ({ ...f, withNotes: false })) }]
      : []),
    ...(filters.nearby
      ? [{ key: "nearby", label: "Near current location", remove: () => setFilters((f) => ({ ...f, nearby: false })) }]
      : []),
  ];
  const narrowed = activeChips.length > 0 || terms.length > 0;

  const clearAll = () => {
    setFilters(NO_FILTERS);
    setQuery("");
  };

  return (
    <>
      <header className="sidebar-header annot-header">
        <h2>Annotations</h2>
        <p className="sidebar-count">
          {narrowed ? `${filteredRows.length} of ${rows.length}` : rows.length} annotation
          {rows.length === 1 ? "" : "s"}
        </p>

        <div className="search-field">
          <Search className="search-field-icon" width={15} height={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search highlights and notes"
            aria-label="Search annotations"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="search-field-clear"
              title="Clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X width={14} height={14} />
            </button>
          ) : null}
        </div>

        <div className="annot-toolbar">
          <FiltersMenu
            filters={filters}
            onChange={setFilters}
            kindCounts={kindCounts}
            colorsInUse={colorsInUse}
            nearbyLabel="Near current location"
          />
          <select
            className="annot-toolbar-button annot-sort"
            value={sort}
            aria-label="Sort annotations"
            onChange={(event) => setSort(event.target.value as AnnotationSort)}
          >
            <option value="document">By location</option>
            <option value="recent">Newest</option>
          </select>
          <span className="annot-toolbar-spacer" />
          <button
            type="button"
            className="annot-toolbar-button annot-toolbar-icon"
            title={copiedAll ? "Copied" : "Copy shown annotations as Markdown"}
            aria-label="Copy shown annotations as Markdown"
            disabled={filteredRows.length === 0}
            onClick={() => copyAll(groupsAsMarkdown(groups))}
          >
            {copiedAll ? <Check width={14} height={14} strokeWidth={2.25} /> : <ClipboardCopy width={14} height={14} strokeWidth={2} />}
          </button>
          <button
            type="button"
            className="annot-toolbar-button annot-new-note"
            title="Write a note about the whole document"
            onClick={() => setComposing(true)}
            disabled={composing}
          >
            <Plus width={14} height={14} strokeWidth={2.5} aria-hidden="true" />
            Note
          </button>
        </div>

        {activeChips.length > 0 ? (
          <div className="annot-chips">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="annot-chip"
                title="Remove filter"
                onClick={chip.remove}
              >
                {chip.label}
                <X width={11} height={11} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="annot-chips-clear" onClick={() => setFilters(NO_FILTERS)}>
              Clear
            </button>
          </div>
        ) : null}
      </header>

      <div className="sidebar-list annot-list">
        {composing ? (
          <div className="annot-composer">
            <NoteEditor
              initialValue=""
              placeholder="A note about this document"
              allowEmpty={false}
              onSave={(text) => {
                onAddNote(text);
                setComposing(false);
              }}
              onCancel={() => setComposing(false)}
            />
          </div>
        ) : null}

        {rows.length === 0 ? (
          composing ? null : (
            <div className="sidebar-empty">
              <p>No annotations yet</p>
              <ul className="annot-empty-tips">
                <li>Select content in the document to create a highlight or note.</li>
                <li>Use the sticky note tool to place a note beside a passage.</li>
                <li>Use <strong>+ Note</strong> above for a note about the whole document.</li>
              </ul>
            </div>
          )
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            <p>Nothing matches {terms.length > 0 ? `“${query.trim()}”` : "these filters"}.</p>
            <button type="button" className="annot-button annot-button--quiet annot-empty-clear" onClick={clearAll}>
              Clear search and filters
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="annot-group">
              <h3 className="search-group-heading annot-group-heading">
                <span className="annot-group-title" title={group.title}>
                  {group.title}
                </span>
                <span className="search-group-count">{group.rows.length}</span>
              </h3>
              {group.rows.map((row) => (
                <AnnotationCard
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  terms={terms}
                  showLocation={group.showLocation}
                  pageLabel={pageLabel}
                  editRequested={row.id === editRequestId}
                  onEditRequestHandled={onEditRequestHandled}
                  onJumpToSource={onJumpToSource}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </>
  );
}
