import type { DiveTreeSummary, GeneralNote, Pin } from "../deepdive/types.ts";

// Readers project their own anchors into ordered locations and callbacks.
// The panel never interprets PDF rectangles or native text/object anchors.
export type AnnotationKind = "highlight" | "area" | "sticky" | "dive" | "pin" | "note";
export type AnnotationSort = "document" | "recent";

export interface AnnotationRow {
  id: string;
  kind: AnnotationKind;
  position?: number;
  locationLabel?: string;
  // Relative offset within a location, for document order.
  top: number;
  createdAt?: string;
  // Position in its source list (newest first) — the recency fallback for
  // highlights saved before createdAt was recorded.
  sourceIndex: number;
  text: string;
  // `text` is a stand-in label (e.g. an area highlight with no text), not
  // content to quote, search, or copy.
  textIsPlaceholder?: boolean;
  image?: string;
  comment?: string;
  color?: string;
  // For a dive highlight: the dive it was made in.
  context?: string;
  isActive: boolean;
  onOpen?: () => void;
  onDelete: () => void;
  // Set when a delete can't be undone with ⌘Z (or takes a dive conversation
  // with it) — the delete button then asks first, showing this.
  deleteWarning?: string;
  // A general note or sticky note (editsText) edits its own text, which
  // can't be emptied; every other kind edits the note attached to it, which
  // can be cleared to remove it.
  onEdit: (text: string) => void;
  editsText?: boolean;
  // Optional reader-specific hover feedback.
  onHover?: (hovered: boolean) => void;
  // Present only for an associated, existing dive. Never starts a new one.
  onOpenDive?: () => void;
  // A highlight whose dive tree has been summarized (the treeSummary
  // experiment): the summary, and how many answers the tree has gained since.
  diveSummary?: DiveTreeSummary;
  diveSummaryNewAnswers?: number;
}

export interface AnnotationSection {
  title: string;
  position: number;
}

export interface AnnotationGroup {
  key: string;
  title: string;
  rows: AnnotationRow[];
  // False when the group heading already names the location.
  showLocation: boolean;
}

// Quoted passages flow as one run; the reader's own notes keep line breaks.
export function flowText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function annotationRangeAt(sections: AnnotationSection[] | null, currentPosition: number): [number, number] | null {
  if (!sections || sections.length === 0) return null;
  const activeIndex = sectionIndexAt(sections, currentPosition);
  if (activeIndex === -1) return [1, sections[0].position - 1];
  const next = sections[activeIndex + 1];
  return [sections[activeIndex].position, next ? next.position - 1 : Number.POSITIVE_INFINITY];
}

function sectionIndexAt(sections: AnnotationSection[], position: number): number {
  let index = -1;
  sections.forEach((section, sectionIndex) => {
    if (section.position <= position) index = sectionIndex;
  });
  return index;
}

function dayLabel(iso: string | undefined): string {
  if (!iso) return "Earlier";
  const date = new Date(iso);
  const today = new Date();
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

// Newest first; rows with no createdAt (older highlights) go last, in the
// order they were added.
function compareRecent(a: AnnotationRow, b: AnnotationRow): number {
  if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  if (a.createdAt) return -1;
  if (b.createdAt) return 1;
  return a.sourceIndex - b.sourceIndex;
}

// A dive highlight shares its anchor highlight's location, so it
// sorts right after it.
const DOCUMENT_KIND_RANK: Record<AnnotationKind, number> = {
  highlight: 0,
  area: 0,
  sticky: 0,
  dive: 1,
  pin: 2,
  note: 2,
};

function compareDocument(a: AnnotationRow, b: AnnotationRow): number {
  return (
    (a.position ?? 0) - (b.position ?? 0) ||
    a.top - b.top ||
    DOCUMENT_KIND_RANK[a.kind] - DOCUMENT_KIND_RANK[b.kind] ||
    compareRecent(b, a)
  );
}

export function groupAnnotationRows(
  rows: AnnotationRow[],
  sort: AnnotationSort,
  sections: AnnotationSection[] | null,
  positionLabel: (position: number) => string,
): AnnotationGroup[] {
  const groups: AnnotationGroup[] = [];
  const push = (key: string, title: string, row: AnnotationRow, showLocation: boolean) => {
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, title, rows: [row], showLocation });
  };

  if (sort === "recent") {
    [...rows].sort(compareRecent).forEach((row) => {
      const title = dayLabel(row.createdAt);
      push(title, title, row, true);
    });
    return groups;
  }

  // Document order: general notes, placed annotations grouped by section
  // (or location), then saved passages without a document location.
  const notes = rows.filter((row) => row.kind === "note").sort(compareRecent);
  const placed = rows.filter((row) => row.kind !== "note" && row.position != null).sort(compareDocument);
  const unplaced = rows.filter((row) => row.kind !== "note" && row.position == null).sort(compareRecent);

  notes.forEach((row) => push("notes", "General notes", row, false));
  placed.forEach((row) => {
    const position = row.position!;
    if (sections && sections.length > 0) {
      const index = sectionIndexAt(sections, position);
      push(`section-${index}`, index === -1 ? "Front matter" : sections[index].title, row, true);
    } else {
      push(`location-${position}`, positionLabel(position), row, false);
    }
  });
  unplaced.forEach((row) => push("unplaced", "Other annotations", row, false));
  return groups;
}

export function studyAnnotationRows({ pins, notes, onDeletePin, onEditPin, onDeleteNote, onEditNote }: {
  pins: Pin[];
  notes: GeneralNote[];
  onDeletePin: (id: string) => void;
  onEditPin: (id: string, comment: string) => void;
  onDeleteNote: (id: string) => void;
  onEditNote: (id: string, text: string) => void;
}): AnnotationRow[] {
  return [
    ...pins.map((pin, sourceIndex): AnnotationRow => ({
      id: pin.id, kind: "pin", top: 0, createdAt: pin.createdAt, sourceIndex,
      text: flowText(pin.text), comment: pin.comment, context: pin.context,
      isActive: false, onDelete: () => onDeletePin(pin.id),
      deleteWarning: "This can't be undone.", onEdit: (comment) => onEditPin(pin.id, comment),
    })),
    ...notes.map((note, sourceIndex): AnnotationRow => ({
      id: note.id, kind: "note", top: 0, createdAt: note.createdAt, sourceIndex,
      text: note.text, isActive: false, onDelete: () => onDeleteNote(note.id),
      deleteWarning: "This can't be undone.", onEdit: (text) => onEditNote(note.id, text), editsText: true,
    })),
  ];
}
