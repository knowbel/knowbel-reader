import { flowText, type AnnotationRow, type AnnotationSection } from "../annotations/model.ts";
import type { AskThread } from "../ask/types.ts";
import { anchorLabel, blockIndices, resolveAnchor, sameAnchor } from "./anchors.ts";
import type { DocumentAnnotation, FlowAnchor, FlowDocument } from "./model.ts";

export function nativeAnnotationSections(document: FlowDocument): AnnotationSection[] {
  const indices = blockIndices(document);
  return document.outline.flatMap((heading) => {
    const index = indices.get(heading.blockId);
    return index === undefined ? [] : [{ title: heading.title, position: index + 1 }];
  });
}

export function nativeAnnotationRows(document: FlowDocument, annotations: DocumentAnnotation[], {
  activeId, threads = [], onOpen, onHover, onDelete, onEdit, onOpenDive,
}: {
  activeId?: string | null;
  threads?: AskThread[];
  onOpen: (anchor: FlowAnchor) => void;
  onHover?: (id: string | null) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, comment: string) => void;
  onOpenDive: (threadId: string) => void;
}): AnnotationRow[] {
  const indices = blockIndices(document);
  const objects = new Map(document.objects.map((object) => [`${object.blockId}/${object.id}`, object]));
  return annotations.map((annotation, sourceIndex) => {
    const dive = threads.find((thread) => thread.mode === "dive" && !thread.parentThreadId && thread.anchor && sameAnchor(thread.anchor, annotation.anchor));
    const anchor = resolveAnchor(document, annotation.anchor);
    const point = anchor?.kind === "text" ? anchor.start : anchor;
    const index = point ? indices.get(point.blockId) : undefined;
    const object = anchor?.kind === "object" ? objects.get(`${anchor.blockId}/${anchor.objectId}`) : undefined;
    const sticky = annotation.kind === "sticker";
    const text = sticky ? annotation.comment.trim() : flowText(annotation.text);
    return {
      id: annotation.id,
      kind: sticky ? "sticky" : annotation.anchor.kind === "object" ? "area" : "highlight",
      position: index === undefined ? undefined : index + 1,
      locationLabel: anchor ? anchorLabel(document, anchor) : "Location unavailable",
      top: index === undefined ? 0 : (anchor?.kind === "text" ? anchor.start.offset : object?.start ?? 0) / Math.max(1, document.blocks[index].text.length),
      createdAt: annotation.createdAt, sourceIndex,
      text: text || (sticky ? "Empty sticky note" : object?.label || "Highlight"),
      textIsPlaceholder: !text,
      comment: sticky ? undefined : annotation.comment,
      color: sticky ? undefined : annotation.color,
      editsText: sticky,
      isActive: annotation.id === activeId,
      onOpen: anchor ? () => onOpen(anchor) : undefined,
      onHover: onHover ? (hovered) => onHover(hovered ? annotation.id : null) : undefined,
      onDelete: () => onDelete(annotation.id),
      onEdit: (comment) => onEdit(annotation.id, comment),
      onOpenDive: dive ? () => onOpenDive(dive.id) : undefined,
    };
  });
}
