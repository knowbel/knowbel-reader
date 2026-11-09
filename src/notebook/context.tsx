import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { AskContext } from "../ask/job";
import type { ResolvedRef } from "../grounding/CitationChip";
import type { NotebookCapture } from "./model";
import type { NotebookStore } from "./store";
import type { Attachment } from "../grounding/attachments";

export interface NotebookBindings {
  store: NotebookStore;
  getAskContext: () => AskContext | null;
  pageLabel: (position: number) => string;
  onJumpToSource: (ref: ResolvedRef) => void;
  onOpenCapture: (capture: NotebookCapture) => void;
  onHoverCapture?: (capture: NotebookCapture | null) => void;
  onOpenConversation?: (id: string, turnId?: string) => boolean;
  attachmentsForCapture?: (capture: NotebookCapture) => Attachment[];
}
const Context = createContext<NotebookBindings | null>(null);
export function NotebookProvider({ value, children }: { value: NotebookBindings; children: ReactNode }) {
  const latest = useRef(value); latest.current = value;
  // Reader location changes must not invalidate every rich block in a large
  // notebook. Delegates read the latest reader callbacks when invoked.
  const hasAttachmentAdapter = !!value.attachmentsForCapture;
  const stable = useMemo<NotebookBindings>(() => ({
    store: value.store,
    getAskContext: () => latest.current.getAskContext(),
    pageLabel: (position) => latest.current.pageLabel(position),
    onJumpToSource: (ref) => latest.current.onJumpToSource(ref),
    onOpenCapture: (capture) => latest.current.onOpenCapture(capture),
    onHoverCapture: (capture) => latest.current.onHoverCapture?.(capture),
    onOpenConversation: (id, turnId) => latest.current.onOpenConversation?.(id, turnId) ?? false,
    ...(hasAttachmentAdapter ? { attachmentsForCapture: (capture) => latest.current.attachmentsForCapture?.(capture) ?? [] } : {}),
  }), [value.store, hasAttachmentAdapter]);
  return <Context.Provider value={stable}>{children}</Context.Provider>;
}
// The hook and provider share this private context.
// oxlint-disable-next-line react/only-export-components
export function useNotebook() { return useContext(Context); }
