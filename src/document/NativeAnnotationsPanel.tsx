import { useCallback, useMemo } from "react";
import { useAskThreads, type AskStore } from "../ask/store";
import AnnotationsPanel from "../components/AnnotationsPanel";
import { studyAnnotationRows } from "../annotations/model";
import type { GeneralNote, Pin } from "../deepdive/types";
import type { ResolvedRef } from "../grounding/CitationChip";
import { nativeAnnotationRows, nativeAnnotationSections } from "./annotationRows";
import type { DocumentEngine } from "./engine";
import type { DocumentAnnotation, FlowAnchor } from "./model";

export default function NativeAnnotationsPanel({
  engine, annotations, pins, notes, askStore, currentUnit, activeId, editRequestId, onEditRequestHandled,
  onOpen, onHover, onDelete, onEdit, onOpenDive, onDeletePin, onEditPin, onAddNote, onEditNote, onDeleteNote, onJumpToSource,
}: {
  engine: DocumentEngine;
  annotations: DocumentAnnotation[];
  pins: Pin[];
  notes: GeneralNote[];
  askStore: AskStore;
  currentUnit: number;
  activeId?: string | null;
  editRequestId: string | null;
  onEditRequestHandled: () => void;
  onOpen: (anchor: FlowAnchor) => void;
  onHover: (id: string | null) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, comment: string) => void;
  onOpenDive: (threadId: string) => void;
  onDeletePin: (id: string) => void;
  onEditPin: (id: string, comment: string) => void;
  onAddNote: (text: string) => void;
  onEditNote: (id: string, text: string) => void;
  onDeleteNote: (id: string) => void;
  onJumpToSource: (ref: ResolvedRef) => void;
}) {
  const model = engine.document;
  const threads = useAskThreads(askStore);
  const positionLabel = useCallback((unit: number) => engine.labelForUnit(unit), [engine]);
  const sections = useMemo(() => nativeAnnotationSections(model), [model]);
  const rows = useMemo(() => [
    ...nativeAnnotationRows(model, annotations, { activeId, threads, onOpen, onHover, onDelete, onEdit, onOpenDive }),
    ...studyAnnotationRows({ pins, notes, onDeletePin, onEditPin, onEditNote, onDeleteNote }),
  ], [model, annotations, threads, activeId, onOpen, onHover, onDelete, onEdit, onOpenDive, pins, notes, onDeletePin, onEditPin, onEditNote, onDeleteNote]);
  return <AnnotationsPanel rows={rows} sections={sections} currentPosition={currentUnit}
    positionLabel={positionLabel} pageLabel={positionLabel}
    onAddNote={onAddNote} onJumpToSource={onJumpToSource}
    editRequestId={editRequestId} onEditRequestHandled={onEditRequestHandled}
  />;
}
