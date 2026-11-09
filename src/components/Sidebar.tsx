import type { PDFDocumentProxy } from "pdfjs-dist";
import SidebarFrame from "./SidebarFrame";
import TableOfContentsPanel from "./TableOfContentsPanel";
import GlossaryPanel, { type GlossaryFocusRequest } from "./GlossaryPanel";
import SearchPanel, { type SearchMatch } from "./SearchPanel";
import type { GlossaryStore } from "../glossary/store";
import type { GlossaryRef } from "../glossary/types";
import AskPanel from "../ask/AskPanel";
import type { AskContext } from "../ask/job";
import type { AskStore } from "../ask/store";
import type { ResolvedRef } from "../grounding/CitationChip";
import type { Attachment } from "../grounding/attachments";

export type SidebarPanel = "annotations" | "toc" | "glossary" | "search" | "ask";

interface SidebarProps {
  activePanel: SidebarPanel | null;
  onSelectPanel: (panel: SidebarPanel) => void;
  pdfDocument: PDFDocumentProxy | null;
  pageLabels: string[] | null;
  currentPage: number;
  onGoToPage: (pageNumber: number) => void;
  glossaryStore: GlossaryStore;
  glossaryFocusRequest: GlossaryFocusRequest | null;
  onJumpToGlossaryRef: (ref: GlossaryRef) => void;
  onRetryGlossaryEntry: (entryId: string) => void;
  onDeleteGlossaryEntry: (entryId: string) => void;
  glossaryMarksVisible: boolean;
  onGlossaryMarksVisibleChange: (visible: boolean) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchFocusRequest: number;
  onJumpToSearchMatch: (match: SearchMatch) => void;
  askStore: AskStore;
  getAskContext: () => AskContext | null;
  openAskThreadId: string | null;
  onOpenAskThread: (threadId: string | null) => void;
  askFocusRequest: number;
  onJumpToSource: (ref: ResolvedRef) => void;
  askAttachments: Attachment[];
  onAddToAsk: (kind: Attachment["kind"], text: string) => void;
  onRemoveAskAttachment: (id: string) => void;
  onClearAskAttachments: () => void;
  onPin: (text: string, context: string) => void;
}

export default function Sidebar({
  activePanel,
  onSelectPanel,
  pdfDocument,
  pageLabels,
  currentPage,
  onGoToPage,
  glossaryStore,
  glossaryFocusRequest,
  onJumpToGlossaryRef,
  onRetryGlossaryEntry,
  onDeleteGlossaryEntry,
  glossaryMarksVisible,
  onGlossaryMarksVisibleChange,
  searchQuery,
  onSearchQueryChange,
  searchFocusRequest,
  onJumpToSearchMatch,
  askStore,
  getAskContext,
  openAskThreadId,
  onOpenAskThread,
  askFocusRequest,
  onJumpToSource,
  askAttachments,
  onAddToAsk,
  onRemoveAskAttachment,
  onClearAskAttachments,
  onPin,
}: SidebarProps) {
  // The rail that picks the panel is AppRail, shared with Deep Dive; this is
  // only the open panel itself.
  if (!activePanel) return null;

  return (
    <SidebarFrame onClose={() => onSelectPanel(activePanel)}>
        {activePanel === "search" ? (
          <SearchPanel
            pdfDocument={pdfDocument}
            pageLabels={pageLabels}
            query={searchQuery}
            onQueryChange={onSearchQueryChange}
            focusRequest={searchFocusRequest}
            onJumpToMatch={onJumpToSearchMatch}
          />
        ) : activePanel === "ask" ? (
          <AskPanel
            store={askStore}
            getContext={getAskContext}
            hasDocument={Boolean(pdfDocument)}
            pageLabels={pageLabels}
            openThreadId={openAskThreadId}
            onOpenThread={onOpenAskThread}
            onJumpToSource={onJumpToSource}
            focusRequest={askFocusRequest}
            attachments={askAttachments}
            onAddToQuestion={onAddToAsk}
            onRemoveAttachment={onRemoveAskAttachment}
            onClearAttachments={onClearAskAttachments}
            onPin={onPin}
          />
        ) : activePanel === "glossary" ? (
          <GlossaryPanel
            store={glossaryStore}
            pageLabels={pageLabels}
            focusRequest={glossaryFocusRequest}
            onJumpToRef={onJumpToGlossaryRef}
            onRetry={onRetryGlossaryEntry}
            onDelete={onDeleteGlossaryEntry}
            marksVisible={glossaryMarksVisible}
            onMarksVisibleChange={onGlossaryMarksVisibleChange}
          />
        ) : (
          <TableOfContentsPanel
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            goToPage={onGoToPage}
            pageLabels={pageLabels}
          />
        )}
    </SidebarFrame>
  );
}
