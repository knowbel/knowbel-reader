import { revealConversationTurn } from "../notebook/revealTurn";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getStorage } from "../storage";
import { openDocument } from "../storage/documents";
import { DocDataWriter } from "../storage/docDataWriter";
import type { DocumentMeta } from "../storage/types";
import { DOCUMENT_FILE_ACCEPT, parseDocument, releaseDocument } from "./registry";
import { DocumentEngine } from "./engine";
import SectionNavigator from "../navigation/SectionNavigator";
import type { DocumentAnnotation, FlowAnchor, FlowReference, TextPoint } from "./model";
import { anchorLabel, anchorText, sameAnchor, textAnchor } from "./anchors";
import FlowView, { FlowPreview, type FlowSelection, type FlowGlossaryMark, type FlowAreaSelection } from "./FlowView";
import SidebarFrame from "../components/SidebarFrame";
import AppRail, { type HighlightPen, type Tool } from "../components/AppRail";
import type { SidebarPanel } from "../components/Sidebar";
import FloatingTip from "../components/FloatingTip";
import HighlightToolbar from "../components/HighlightToolbar";
import { flowSnapshot } from "../notebook/nativeCapture";
import { saveNotebookExcerpt } from "../notebook/capture";
import { showNotice } from "../components/notices";
import { useTheme } from "../theme";
import { canRevealFiles, openExternal } from "../library/desktop";
import { safeDocumentUrl } from "./model";
import { HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import { STICKER_DEFAULT_PAPER, STICKER_PAPER_PRESETS, STICKER_PAPER_NAMES } from "../stickerStyles";
import { GlossaryStore, useGlossaryEntries } from "../glossary/store";
import { addGlossaryTerm, cancelGlossaryJob, runGlossaryJob } from "../glossary/job";
import { isGlossaryCandidate } from "../glossary/textIndex";
import type { GlossaryEntry, GlossaryRef } from "../glossary/types";
import type { GlossaryFocusRequest } from "../components/GlossaryPanel";
import { AskStore } from "../ask/store";
import { newThread, type AskContext } from "../ask/job";
import type { AskThread } from "../ask/types";
import type { ResolvedRef } from "../grounding/CitationChip";
import type { SourceRef } from "../grounding/types";
import { addAttachment, ATTACHMENT_MAX_CHARS, makeAttachment, type Attachment } from "../grounding/attachments";
import { importFiles } from "../library/importFiles";
import "./reader.css";
import "../web/page.css";
import { useDraftAttachments } from "../notebook/drafts";
import { NotebookStore, useNativeMarks } from "../notebook/store";
import { useReaderPersistence } from "../notebook/useReaderPersistence";
import { NotebookProvider } from "../notebook/context";
import { captureEntryId, type NotebookCapture } from "../notebook/model";
import PersistentFlowPane from "./PersistentFlowPane";
import { sendNativeDive } from "./nativeDives";
import { openingMessage } from "../deepdive/prompts";
import { pageQuote, pageSelectionAnchor, samePage } from "../web/selection";
import type { PageInteraction, PageMark } from "../web/browser";
const NotebookDock = lazy(() => import("../notebook/NotebookDock"));
const EmbeddedPage = lazy(() => import("../web/EmbeddedPage"));
const NativeDiveView = lazy(() => import("./NativeDiveView"));


const AskPanel = lazy(() => import("../ask/AskPanel"));
const GlossaryPanel = lazy(() => import("../components/GlossaryPanel"));
const GlossaryCard = lazy(() => import("../glossary/GlossaryCard"));

interface Session {
  notebook: NotebookStore;
  meta: DocumentMeta;
  engine: DocumentEngine;
  annotations: DocumentAnnotation[];
  writer: DocDataWriter;
  glossary: GlossaryStore;
  ask: AskStore;
  saves: { error: unknown };
  diveControllers: Map<string, AbortController>;
}

export default function NativeReader({ initialDocument, onHome, onOpenDocument }: {
  initialDocument: DocumentMeta; onHome: () => void; onOpenDocument: (meta: DocumentMeta) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const storage = getStorage();
      const bytes = await storage.getFile(initialDocument.docId);
      if (!bytes) throw new Error("The document's source file couldn't be read from the library.");
      const model = await parseDocument(initialDocument.format!, { id: initialDocument.docId, bytes, fileName: initialDocument.fileName });
      if (cancelled) return;
      const opened = await openDocument(storage, { bytes, docId: initialDocument.docId, fileName: initialDocument.fileName });
      if (cancelled) return;
      const saves = { error: null as unknown };
      const writer = new DocDataWriter(storage, (error) => { saves.error = error; showNotice("Couldn't save your notes. Keep the document open and try again."); });
      const stored = <T,>(kind: keyof typeof opened.data) => Array.isArray(opened.data[kind]) ? opened.data[kind] as T[] : [];
      const glossary = new GlossaryStore();
      const ask = new AskStore();
      glossary.load(stored<GlossaryEntry>("glossary"), (entries) => writer.schedule(model.id, "glossary", entries));
      ask.load(stored<AskThread>("threads"), (threads) => writer.schedule(model.id, "threads", threads));
      const notebook = new NotebookStore(storage);
      await notebook.load(model.id, opened.data);
      const annotations = notebook.getNativeAnnotations();
      writer.prime(model.id, "nativeAnnotations", annotations);
      setSession({ notebook, meta: opened.meta, engine: new DocumentEngine(model), annotations, writer, glossary, ask, saves, diveControllers: new Map() });
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Couldn't open this document."); });
    return () => { cancelled = true; };
  }, [initialDocument]);
  if (!session) return <div className="reader-loading" role={error ? "alert" : "status"}>{error || `Opening ${initialDocument.title}…`}
    <button type="button" onClick={onHome}>Library</button></div>;
  return <NativeWorkspace session={session} onHome={onHome} onOpenDocument={onOpenDocument} />;
}

// Stable event callbacks let the memoized document view stay untouched as
// sidebar state and streamed answers change. No document-wide DOM rebuilds.
function useEvent<T extends (...args: never[]) => unknown>(callback: T): T {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback(((...args: Parameters<T>) => latest.current(...args)) as T, []);
}

function NativeWorkspace({ session, onHome, onOpenDocument }: { session: Session; onHome: () => void; onOpenDocument: (meta: DocumentMeta) => void }) {
  const { engine, writer, glossary, ask: askStore, notebook } = session;
  const model = engine.document;
  const sourceUrl = session.meta.source?.canonicalUrl || session.meta.source?.url;
  const canShowPage = canRevealFiles && model.format === "html" && session.meta.source?.format === "article";
  const pageUrl = session.meta.source?.finalUrl || sourceUrl;
  const pageOwner = "reader-" + model.id;
  const [pageMode, setPageMode] = useState(canShowPage && session.meta.view?.pageMode !== false);
  const [pageOpened, setPageOpened] = useState(pageMode);
  const pageLoaded = useRef(false);
  // False after the user follows a link away from the saved article.
  const pageOnDocument = useRef(true);
  // The original page saved as a web archive, replayed when offline or when
  // the live page won't load.
  const [archivedAt, setArchivedAt] = useState(session.meta.source?.pageArchivedAt);
  const [pageSource, setPageSource] = useState<"live" | "saved">(() => !navigator.onLine && session.meta.source?.pageArchivedAt ? "saved" : "live");
  const [pageStalled, setPageStalled] = useState(false);
  const archiving = useRef<Promise<void> | null>(null), archivedThisVisit = useRef(0);
  const settledBeforeReady = useRef(false), drainPage = useRef<(() => void) | null>(null);
  const pageFocused = useRef<number | null>(null);
  const [pageRevision, setPageRevision] = useState(0);
  const annotations = useNativeMarks(notebook);
  const setAnnotations = notebook.setNativeAnnotations;
  const [notebookOpen, setNotebookOpen] = useState(session.meta.view?.notebookOpen ?? true);
  notebook.onReveal = () => setNotebookOpen(true);

  const [panel, setPanel] = useState<SidebarPanel | null>(session.meta.view?.panel === "annotations" ? null : session.meta.view ? session.meta.view.panel as SidebarPanel | null : null);
  const [tool, setTool] = useState<Tool>("select");
  const [pen, setPen] = useState<HighlightPen>(() => {
    try { const saved = JSON.parse(localStorage.getItem("highlight-pen") ?? "null");
      if (saved && typeof saved.color === "string" && ["highlight", "underline", "strikethrough"].includes(saved.style)) return saved;
    } catch { /* use default */ }
    return { color: HIGHLIGHT_COLOR_PRESETS[0], style: "highlight" };
  });
  useEffect(() => { const update = (event: Event) => setPen((event as CustomEvent<HighlightPen>).detail); window.addEventListener("knowbel-pen-change", update); return () => window.removeEventListener("knowbel-pen-change", update); }, []);
  const [scale, setScale] = useState(session.meta.textScale ?? 100);
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

  const [selection, setSelection] = useState<FlowSelection | null>(null);
  const [references, setReferences] = useState<FlowReference[]>([]);
  const [referencePreview, setReferencePreview] = useState<{ targets: FlowReference["targets"]; rect: FlowSelection["rect"] } | null>(null);
  const showReference = useEvent((targets: FlowReference["targets"], rect: FlowSelection["rect"]) => { setReferencePreview({ targets, rect }); });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => { void engine.getReferences().then((references) => { if (!cancelled) setReferences(references); }).catch(() => {}); }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [engine]);
  const [tipGlossaryId, setTipGlossaryId] = useState<string | null>(null);
  const [glossaryFocus, setGlossaryFocus] = useState<GlossaryFocusRequest | null>(null);
  const [glossaryMarksVisible, setGlossaryMarksVisible] = useState(() => { try { return localStorage.getItem("glossary-marks-visible") !== "false"; } catch { return true; } });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searchMatches = useMemo(() => engine.search(deferredQuery), [engine, deferredQuery]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [askFocus, setAskFocus] = useState(0);
  const [openThreadId, setOpenThreadId] = useState<string | null>(session.meta.view?.threadId ?? null);
  const [diveFocusId, setDiveFocusId] = useState<string | null>(() => { const id = session.meta.view?.nativeDiveFocus; return id && askStore.get(id)?.mode === "dive" ? id : null; });
  const [diveHighlightFocusId, setDiveHighlightFocusId] = useState<string | null>(null);
  const workspaceSlotRef = useRef<HTMLDivElement>(null), diveSlotRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useDraftAttachments(notebook.drafts, `ask:${openThreadId ?? "new-question"}`);
  const [currentUnit, setCurrentUnit] = useState(1);
  const [navigationFocusRequest, setNavigationFocusRequest] = useState(0);
  const [navigate, setNavigate] = useState<{ anchor: FlowAnchor; sequence: number } | null>(() => {
    if (pageMode) return null;
    const point = session.meta.readingPosition;
    const block = point && model.blocks.find((block) => block.id === point.blockId);
    return block ? { anchor: textAnchor(model, point!, { blockId: block.id, offset: block.text.length }), sequence: 0 } : null;
  });
  const [flash, setFlash] = useState<FlowAnchor | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const metaRef = useRef(session.meta);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const metaWrites = useRef(Promise.resolve());
  const controller = useRef(new AbortController());
  const jobs = useRef(new Set<Promise<void>>());

  const history = useRef<{ back: FlowAnchor[]; forward: FlowAnchor[] }>({ back: [], forward: [] });
  const [, updateHistory] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const { theme, toggleTheme } = useTheme();
  const glossaryEntries = useGlossaryEntries(glossary);
  const glossaryProjection = useRef<{ sources: GlossaryEntry["refs"][]; marks: FlowGlossaryMark[] }>({ sources: [], marks: [] });
  const refLists = glossaryMarksVisible ? glossaryEntries.map((entry) => entry.refs) : [];
  if (refLists.length !== glossaryProjection.current.sources.length || refLists.some((refs, i) => refs !== glossaryProjection.current.sources[i])) {
    glossaryProjection.current = { sources: refLists, marks: glossaryMarksVisible ? glossaryEntries.flatMap((entry) => entry.refs.flatMap((ref) =>
      ref.location ? [{ entryId: entry.id, anchor: ref.location }] : [])) : [] };
  }
  const showGlossary = useEvent((entryId: string, rect: FlowSelection["rect"]) => {
    const entry = glossary.get(entryId);
    const anchor = entry?.refs.find((ref) => ref.location)?.location;
    if (anchor) { setSelection({ anchor, rect }); setTipGlossaryId(entryId); }
  });

  const saveMeta = useEvent(() => {
    clearTimeout(saveTimer.current);
    const meta = metaRef.current;
    metaWrites.current = metaWrites.current.catch(() => {}).then(() => getStorage().putMeta(meta));
    return metaWrites.current;
  });
  const scheduleMeta = useEvent(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveMeta().catch(() => showNotice("Couldn't save your reading position.")), 700);
  });
  const closeJobs = useEvent(() => {
    notebook.cancelJobs();
    controller.current.abort();
    session.diveControllers.forEach((controller) => controller.abort());
    session.diveControllers.clear();
    for (const entry of glossary.getSnapshot()) cancelGlossaryJob(entry.id);
  });
  const flush = useEvent(async () => {
    await Promise.allSettled([...jobs.current]);
    if (pageOpened && pageLoaded.current) {
      try {
        const { readPageSelection } = await import("../web/browser");
        const state = await readPageSelection(pageOwner);
        if (samePage(state.url, pageUrl!) && Number.isFinite(state.scrollY)) metaRef.current = { ...metaRef.current, view: { zoom: "auto", twoPage: false, continuous: true, panel: null, ...metaRef.current.view, pageScroll: Math.max(0, state.scrollY) } };
      } catch { /* A page that closed or navigated away keeps its last saved position. */ }
    }
    // A failed debounced save is retried with the current in-memory value.
    // If it still fails, the reader stays open with those notes intact.
    session.saves.error = null;
    writer.schedule(model.id, "glossary", glossary.getSnapshot());
    writer.schedule(model.id, "threads", askStore.getSnapshot());
    await Promise.all([writer.flush(), notebook.flush(), saveMeta()]);
    if (session.saves.error) throw session.saves.error;
  });
  const leave = useEvent(async () => {
    closeJobs();
    await archiveBeforeLeaving();
    await flush();
    onHome();
  });
  useReaderPersistence({ checkpoint: notebook.checkpoint, cancel: closeJobs, flush });
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController();
    return () => {
      closeJobs();
      clearTimeout(flashTimer.current);
      clearTimeout(saveTimer.current);
      void Promise.all([writer.flush(), notebook.flush()]).catch(() => {});
      releaseDocument(model.id);
    };
  }, [closeJobs, flush, writer, model.id, notebook]);
  useEffect(() => {
    metaRef.current = { ...metaRef.current, textScale: scale, view: { zoom: "auto", twoPage: false, continuous: true, ...metaRef.current.view, panel, threadId: openThreadId, notebookOpen, nativeDiveFocus: diveFocusId, pageMode } };
    scheduleMeta();
  }, [scale, panel, openThreadId, notebookOpen, diveFocusId, pageMode, scheduleMeta]);
  useEffect(() => { if (panel === "search") searchRef.current?.focus(); }, [panel]);

  const changeAnnotations = useEvent((next: DocumentAnnotation[]) => {
    setAnnotations(next);

  });
  const closeTip = useCallback(() => { setSelection(null); setTipGlossaryId(null); }, []);
  const linkedDiveId = useCallback((annotationId: string) => {
    const id = notebook.getCapture(`native:${annotationId}`)?.conversationId;
    return id && askStore.get(id)?.mode === "dive" ? id : undefined;
  }, [notebook, askStore]);
  const openSavedDive = useCallback((id: string) => {
    closeTip();
    setDiveFocusId(id);
    setPanel(null);
  }, [closeTip]);
  const placeHere = () => {
    const point = metaRef.current.readingPosition;
    return point ? textAnchor(model, point, point) : null;
  };
  const displayAnchor = (anchor: FlowAnchor) => {
    setNavigate((previous) => ({ anchor, sequence: (previous?.sequence ?? 0) + 1 }));
    setFlash(anchor);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2200);
    closeTip();
  };
  const goTo = useEvent((anchor: FlowAnchor) => {
    if (diveFocusId) {
      let root = askStore.get(diveFocusId);
      const seen = new Set<string>();
      while (root?.parentThreadId && !seen.has(root.id)) { seen.add(root.id); root = askStore.get(root.parentThreadId); }
      setDiveFocusId(root?.mode === "dive" ? root.id : null);
    }
    const here = placeHere();
    if (here) history.current.back.push(here);
    if (history.current.back.length > 100) history.current.back.shift();
    history.current.forward = [];
    updateHistory((n) => n + 1);
    displayAnchor(anchor);
  });
  const goHistory = useEvent((direction: "back" | "forward", steps = 1) => {
    const from = history.current[direction];
    if (steps < 1 || steps > from.length) return;
    const to = history.current[direction === "back" ? "forward" : "back"];
    const here = placeHere();
    if (here) to.push(here);
    for (let step = 1; step < steps; step++) to.push(from.pop()!);
    const target = from.pop()!;
    updateHistory((n) => n + 1);
    displayAnchor(target);
  });
  const onPosition = useEvent((point: TextPoint) => {
    const { blockId, offset } = point;
    const unit = (engine.blockIndex.get(blockId) ?? 0) + 1;
    setCurrentUnit(unit);
    metaRef.current = { ...metaRef.current, readingPosition: point, readingProgress: Math.min(1, (unit - 1 + offset / Math.max(1, model.blocks[unit - 1]?.text.length ?? 1)) / Math.max(1, model.blocks.length - 1)) };
    scheduleMeta();
  });
  const saveAnnotation = useEvent((anchor: FlowAnchor, kind: DocumentAnnotation["kind"], comment = "", color = pen.color, style = pen.style, force = false) => {
    const existing = notebook.getSnapshot().captures.find((capture) => capture.native?.kind === kind && sameAnchor(capture.native.anchor, anchor));
    if (existing?.native && !force) {
      const current = notebook.getNativeAnnotations().find((item) => item.id === existing.native!.id);
      if (current) return current;
      const restored = { ...existing.native, comment: notebook.plain(notebook.entryForCapture(existing.id)) };
      setAnnotations((previous) => [restored, ...previous]); return restored;
    }
    const annotation: DocumentAnnotation = { id: crypto.randomUUID(), kind, anchor, text: anchorText(model, anchor), comment, color, style,
      paper: kind === "sticker" ? STICKER_DEFAULT_PAPER : undefined, createdAt: new Date().toISOString() };
    setAnnotations((previous) => [annotation, ...previous]);
    if (anchor.kind === "object") {
      const object = model.objects.find((object) => object.id === anchor.objectId && object.blockId === anchor.blockId);
      if (object?.kind === "table") {
        const block = model.blocks[engine.blockIndex.get(anchor.blockId)!];
        if (block) notebook.enrichCaptures((capture) => capture.id === `native:${annotation.id}` ? { ...capture, snapshotRich: flowSnapshot(block.content) } : capture);
      } else if (object?.kind === "image") {
        const signal = controller.current.signal;
        trackJob((async () => { const attachments = await selectedAttachments(anchor); if (signal.aborted) return; const image = attachments.find((attachment) => attachment.image)?.image; if (!image) return; const imageId = notebook.addImageDataUrl(`data:${image.mediaType};base64,${image.data}`); notebook.enrichCaptures((capture) => capture.id === `native:${annotation.id}` ? { ...capture, imageId } : capture); })().catch(() => {}));
      }
    }
    return annotation;
  });
  const captureSelection = useEvent((next: FlowSelection) => {
    const id = next.annotationId ? linkedDiveId(next.annotationId) : undefined;
    if (id && id !== diveFocusId) {
      openSavedDive(id);
      return;
    }
    setTipGlossaryId(null);
    if (tool === "highlight" && !next.annotationId) {
      saveAnnotation(next.anchor, "highlight");
      window.getSelection()?.removeAllRanges();
      closeTip();
    } else setSelection(next);
  });
  const placeSticker = useEvent((anchor: FlowAnchor) => {
    const annotation = saveAnnotation(anchor, "sticker");

    notebook.reveal(captureEntryId(`native:${annotation.id}`));
    setTool("select");
    setPanel("annotations");
    closeTip();
  });
  const glossaryContext = () => ({ pdfDocument: engine, fileName: session.meta.title, pageLabels: null });
  const jumpGlossary = (ref: GlossaryRef) => { if (ref.location) goTo(ref.location); };
  const jumpSource = (ref: ResolvedRef) => {
    // The citation localizer's offsets are into the same canonical unit.
    // Attached cross-block passages are split into individually anchored sources.
    if (ref.source.location) {
      if (ref.source.location.kind === "text" && ref.range[1] > ref.range[0]) {
        const unit = engine.blockIndex.get(ref.source.location.start.blockId);
        if (unit === undefined) { showNotice("This saved source couldn't be located."); return; }
        goTo(engine.anchorForRange(unit + 1, ...ref.range));
      }
      else goTo(ref.source.location);
    }
  };
  const getAskContext = (): AskContext => {
    if (controller.current.signal.aborted) controller.current = new AbortController();
    return { pdfDocument: engine, fileName: session.meta.title, pageLabel: (unit) => engine.labelForUnit(unit),
      pageLabels: null, currentPage: currentUnit, signal: controller.current.signal };
  };
  const trackJob = (job: Promise<void>) => {
    jobs.current.add(job);
    void job.finally(() => jobs.current.delete(job));
  };
  const attachmentFor = (anchor: FlowAnchor): Attachment[] => engine.ranges(anchor).flatMap((range) => {
    const block = model.blocks[engine.blockIndex.get(range.blockId)!];
    const end = Math.min(range.end, range.start + ATTACHMENT_MAX_CHARS);
    if (end <= range.start) return [];
    return [{ id: crypto.randomUUID(), kind: "document" as const, text: block.text.slice(range.start, end), pageNumber: engine.unitForAnchor(textAnchor(model,
      { blockId: block.id, offset: range.start }, { blockId: block.id, offset: end })), range: [range.start, end] as [number, number],
      location: engine.anchorForRange(engine.blockIndex.get(block.id)! + 1, range.start, end), locationLabel: block.section,
      ...(end < range.end ? { truncated: true } : {}) }];
  }).slice(0, 5);
  const selectedAttachments = async (anchor: FlowAnchor) => {
    if (controller.current.signal.aborted) controller.current = new AbortController();
    const captures = notebook.getSnapshot().captures.filter((capture) => capture.native && capture.imageId && sameAnchor(capture.native.anchor, anchor));
    const capture = captures.find((capture) => capture.native?.id === selection?.annotationId) ?? captures[0];
    const asset = capture?.imageId ? notebook.getAssets().find((asset) => asset.id === capture.imageId) : undefined;
    if (asset) return [{ id: crypto.randomUUID(), kind: "region" as const, text: capture!.text || "Selected area", image: { mediaType: asset.mediaType, data: asset.data }, location: anchor, locationLabel: anchorLabel(model, anchor), pageNumber: engine.unitForAnchor(anchor) }];
    if (anchor.kind === "object" && model.objects.some((object) => object.id === anchor.objectId && object.blockId === anchor.blockId && object.kind === "image")) {
      const { imageAttachment } = await import("./imageAttachment.ts");
      const image = await imageAttachment(engine, anchor, controller.current.signal);
      if (image) return [image];
    }
    return attachmentFor(anchor);
  };
  const captureAttachments = (capture: NotebookCapture): Attachment[] => {
    const attached: Attachment[] = capture.native ? attachmentFor(capture.native.anchor) : (capture.sources ?? []).map((source) => ({ id: crypto.randomUUID(), kind: "document", text: source.text, pageNumber: source.pageNumber, range: [source.start, source.end], location: source.location, locationLabel: source.locationLabel }));
    const asset = capture.imageId ? notebook.getAssets().find((asset) => asset.id === capture.imageId) : undefined;
    if (asset) attached.unshift({ id: crypto.randomUUID(), kind: "region", text: capture.text || "Selected area", image: { mediaType: asset.mediaType, data: asset.data }, location: capture.native?.anchor, locationLabel: capture.locationLabel, pageNumber: capture.position });
    return attached;
  };
  const captureArea = useEvent((area: FlowAreaSelection) => {
    setTool("select"); closeTip();
    const root = document.querySelector<HTMLElement>(".native-reader .flow-scroll");
    if (!root) return;
    const signal = controller.current.signal;
    trackJob((async () => {
      const { default: html2canvas } = await import("html2canvas-pro");
      const bounds = root.getBoundingClientRect();
      const canvas = await html2canvas(root, { x: area.rect.left - bounds.left, y: area.rect.top - bounds.top, width: area.rect.width, height: area.rect.height,
        scale: Math.min(2, 1000 / Math.max(area.rect.width, area.rect.height)), useCORS: true, logging: false, backgroundColor: getComputedStyle(root).backgroundColor,
        onclone: (_document, clonedRoot) => { clonedRoot.querySelectorAll<HTMLElement>(".flow-block").forEach((block) => { block.style.contentVisibility = "visible"; block.style.contain = "layout style paint"; }); } });
      if (signal.aborted) return;
      const annotation = saveAnnotation(area.anchor, "highlight", "", pen.color, pen.style, true);
      const imageId = notebook.addImageDataUrl(canvas.toDataURL("image/jpeg", .88));
      notebook.enrichCaptures((capture) => capture.native?.id === annotation.id ? { ...capture, imageId } : capture);
      notebook.reveal(captureEntryId(`native:${annotation.id}`));
    })().catch(() => showNotice("Couldn't capture that area. Select its text or image instead.")));
  });
  const startSelectionQuestion = (attached: Attachment[]) => {
    if (!attached.length) return;
    if (diveFocusId && askStore.get(diveFocusId)?.mode === "dive") {
      const key = `dive:${diveFocusId}`;
      notebook.drafts?.setAttachments(key, attached.reduce(addAttachment, notebook.drafts.getAttachments(key)));
      return;
    }
    const thread = newThread(attached.map((attachment) => attachment.text).join(" ") || "Selected image");
    notebook.drafts?.setAttachments(`ask:${thread.id}`, attached.reduce(addAttachment, []));
    askStore.add(thread);
    setOpenThreadId(thread.id);
    setPanel("ask"); setAskFocus((n) => n + 1);
  };
  const addToQuestion = (anchor: FlowAnchor) => {
    closeTip();
    trackJob((async () => {
      const attached = await selectedAttachments(anchor);
      if (controller.current.signal.aborted) return;
      startSelectionQuestion(attached);
    })().catch((error) => { if (!controller.current.signal.aborted) showNotice(error instanceof Error ? error.message : "Couldn't attach this selection."); }));
  };
  const dive = useEvent((anchor: FlowAnchor) => {
    closeTip();
    window.getSelection()?.removeAllRanges();
    const findExisting = () => askStore.getSnapshot().find((thread) => thread.mode === "dive" && !thread.parentThreadId && thread.anchor && sameAnchor(thread.anchor, anchor));
    const open = (id: string) => {
      saveAnnotation(anchor, "highlight", "", pen.color, "highlight");
      notebook.enrichCaptures((capture) => capture.native && capture.conversationId !== id && sameAnchor(capture.native.anchor, anchor) ? { ...capture, conversationId: id } : capture);
      openSavedDive(id);
    };
    const existing = findExisting();
    if (existing) {
      goTo(anchor);
      open(existing.id);
      return;
    }
    trackJob((async () => {
      const attached = await selectedAttachments(anchor);
      if (controller.current.signal.aborted || !attached.length) return;
      const existing = findExisting();
      if (existing) return open(existing.id);
      const quote = anchorText(model, anchor).trim();
      const thread = { ...newThread(quote.slice(0, 80) || "Deep Dive"), mode: "dive" as const, anchor, selection: quote, selectionImage: attached.find((attachment) => attachment.image)?.image };
      askStore.add(thread);
      open(thread.id);
      await sendNativeDive(askStore, thread.id, openingMessage(quote), getAskContext(), session.diveControllers, { attachments: attached });
    })().catch((error) => { if (!controller.current.signal.aborted) showNotice(error instanceof Error ? error.message : "Couldn't start this dive."); }));
  });
  const diveFromAnswer = (text: string, sources: SourceRef[]) => {
    const parent = openThreadId ? askStore.get(openThreadId) : undefined;
    const attached = sources.slice(0, 4).map((source): Attachment => ({ id: crypto.randomUUID(), kind: "document", text: source.text,
      pageNumber: source.pageNumber, range: [source.start, source.end], location: source.location, locationLabel: source.locationLabel }));
    const answer = makeAttachment("answer", text);
    if (answer) attached.push(answer);
    const thread: AskThread = { ...newThread(text), mode: "dive", parentThreadId: parent?.mode === "dive" ? parent.id : undefined, anchor: parent?.anchor ?? sources.find((source) => source.location)?.location, selection: text };
    askStore.add(thread);
    setDiveFocusId(thread.id); setPanel(null);
    trackJob(sendNativeDive(askStore, thread.id, "Explain the selected part of the earlier explanation, using the document for context.", getAskContext(), session.diveControllers, { attachments: attached }));
  };
  const openFile = useEvent(async (file: File) => {
    try {
      const imported = await importFiles(getStorage(), [file]);
      const meta = imported.added[0] ?? imported.alreadyThere[0];
      if (!meta) { showNotice("Couldn't read this file."); return; }
      if (meta.docId === model.id) { showNotice("This document is already open."); return; }
      closeJobs(); await archiveBeforeLeaving(); await flush(); onOpenDocument(meta);
    } catch { showNotice("Couldn't save your notes before opening this file. Please try again."); }
  });
  const archivePage = useEvent(() => {
    const storage = getStorage();
    if (archiving.current) return archiving.current;
    if (!storage.putPageArchive || pageSource !== "live" || !pageLoaded.current || !pageOnDocument.current) return Promise.resolve();
    const work = (async () => {
      const { savePageArchive } = await import("../web/browser");
      const bytes = await savePageArchive(pageOwner);
      await storage.putPageArchive!(model.id, bytes);
      const at = new Date().toISOString();
      archivedThisVisit.current = Date.now();
      metaRef.current = { ...metaRef.current, source: metaRef.current.source && { ...metaRef.current.source, pageArchivedAt: at } };
      setArchivedAt(at); scheduleMeta();
    })().catch(() => { /* Keep any earlier saved page; a later visit retries. */ }).finally(() => { archiving.current = null; });
    archiving.current = work; return work;
  });
  // Refresh the archive on the way out once the reader has spent time on the
  // page, so it includes images and code loaded while scrolling.
  const archiveBeforeLeaving = () => archivedThisVisit.current && Date.now() - archivedThisVisit.current > 30000
    ? Promise.race([archivePage(), new Promise<void>((resolve) => setTimeout(resolve, 8000))]) : Promise.resolve();
  useEffect(() => {
    if (!pageOpened || pageSource !== "live" || pageLoaded.current) return;
    const timer = setTimeout(() => { if (!pageLoaded.current) setPageStalled(true); }, 15000);
    return () => clearTimeout(timer);
  }, [pageOpened, pageSource, pageRevision]);
  // The page reports when it has finished loading everything it needs
  // (page_bridge.js); save it then if there's no saved copy or it's a day old.
  const onPageSettled = useEvent((url: string) => {
    if (!pageUrl || !samePage(url, pageUrl)) return;
    if (!pageLoaded.current) { settledBeforeReady.current = true; return; }
    const saved = metaRef.current.source?.pageArchivedAt;
    if (!saved || Date.now() - Date.parse(saved) > 86400000) void archivePage();
  });
  const onPageReady = useEvent((url?: string) => {
    pageOnDocument.current = !url || !pageUrl || samePage(url, pageUrl); pageLoaded.current = true; setPageStalled(false); setPageRevision((revision) => revision + 1);
    if (settledBeforeReady.current && pageUrl) { settledBeforeReady.current = false; onPageSettled(url ?? pageUrl); }
    // A page handed over from the import dialog may have settled already.
    drainPage.current?.();
  });
  const loadArchive = useEvent(async () => (await getStorage().getPageArchive?.(model.id)) ?? null);
  const switchPageSource = (source: "live" | "saved") => { pageLoaded.current = false; setPageStalled(false); setPageSource(source); };
  const onPageLoading = useEvent(() => { pageLoaded.current = false; });
  const focusReader = useEvent(() => { void import("../web/browser").then(({ browserAction }) => browserAction(pageOwner, "reader-focus")).catch(() => {}); });
  const changePen = useEvent((change: Partial<HighlightPen>) => {
    const next = { ...pen, ...change };
    setPen(next); try { localStorage.setItem("highlight-pen", JSON.stringify(next)); } catch { /* session preference */ }
  });
  useEffect(() => {
    if (pageOpened && pageRevision) void import("../web/browser").then(({ browserAction }) => browserAction(pageOwner, "zoom", String(scale / 100))).catch(() => {});
  }, [pageOpened, pageRevision, pageOwner, scale]);
  const pageMarks = useMemo(() => annotations.flatMap((mark): PageMark[] => {
    const quote = pageQuote(model, mark.anchor);
    return quote?.text.trim() ? [{ ...quote, id: mark.id, color: mark.color, style: mark.style, kind: mark.kind, paper: mark.paper, diveId: linkedDiveId(mark.id) }] : [];
  }), [annotations, model, linkedDiveId]);
  // Paint saved marks on the live page and pass it the active tool and pen.
  // A jump (Notebook, search, citation) scrolls the page once per request;
  // a passage the live page no longer has opens in Study text instead.
  useEffect(() => {
    if (!pageMode || !pageRevision) return;
    let cancelled = false;
    const target = navigate && navigate.sequence !== pageFocused.current ? navigate : null;
    const timer = setTimeout(() => {
      const onDocument = pageOnDocument.current;
      const focus = target && onDocument ? pageQuote(model, target.anchor) : null;
      void import("../web/browser").then(({ decoratePage }) => decoratePage(pageOwner, onDocument ? pageMarks : [], focus, { tool, color: pen.color, style: pen.style, activeDiveId: diveFocusId })).then((result) => {
        if (cancelled || !target) return;
        pageFocused.current = target.sequence;
        if (result.found) return;
        setPageMode(false);
        setNavigate((current) => current && { ...current, sequence: current.sequence + 1 });
        showNotice("This passage isn't on the live page, so it's shown in Study text.");
      }).catch(() => {});
    }, target ? 0 : 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pageMode, pageRevision, pageOwner, pageMarks, navigate, model, tool, pen, diveFocusId]);
  // Actions from the live page's selection toolbar, tools and shortcuts. Its
  // selections become the same semantic anchors Study text uses, so notes,
  // questions and dives are shared by both views.
  const handlePageEvent = useEvent((event: PageInteraction) => {
    if (event.action === "settled") { onPageSettled(event.url); return; }
    if (event.action === "key") {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: event.key ?? "", metaKey: !!event.metaKey, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey, shiftKey: !!event.shiftKey, bubbles: true, cancelable: true }));
      if (["f", "j", "o"].includes(event.key ?? "")) focusReader();
      return;
    }
    const penChange = { ...(event.color ? { color: event.color } : {}), ...(event.style ? { style: event.style } : {}) };
    if (event.action === "pen") { changePen(penChange); return; }
    const existing = event.annotationId ? annotations.find((item) => item.id === event.annotationId) : undefined;
    if (event.action === "open-dive") {
      const id = existing && linkedDiveId(existing.id);
      if (id && pageUrl && samePage(event.url, pageUrl)) { openSavedDive(id); focusReader(); }
      return;
    }
    let anchor = existing?.anchor ?? null;
    if (!anchor) {
      if (!pageUrl || !samePage(event.url, pageUrl)) { showNotice("This is a different page. Add its address to the library to take notes on it."); return; }
      anchor = pageSelectionAnchor(model, event);
      if (!anchor) { showNotice(event.text ? "Couldn't match this selection to the saved study text. Select a longer passage, or use Study text." : "Select text on the page first."); return; }
    }
    switch (event.action) {
      case "highlight":
        if (existing) changeAnnotations(annotations.map((item) => item.id === existing.id ? { ...item, color: event.color ?? item.color, style: event.style ?? item.style } : item));
        else saveAnnotation(anchor, "highlight", "", event.color ?? pen.color, event.style ?? pen.style);
        if (event.color || event.style) changePen(penChange);
        return;
      case "open-note": {
        const annotation = existing ?? saveAnnotation(anchor, "highlight");
        notebook.reveal(captureEntryId(`native:${annotation.id}`)); focusReader(); return;
      }
      case "note": placeSticker(anchor); focusReader(); return;
      case "ask": addToQuestion(anchor); focusReader(); return;
      case "dive": dive(anchor); focusReader(); return;
      case "glossary": {
        const id = addGlossaryTerm(glossary, anchorText(model, anchor), engine.unitForAnchor(anchor), glossaryContext());
        if (id) { setPanel("glossary"); setGlossaryFocus({ entryId: id, nonce: Date.now() }); focusReader(); }
        return;
      }
      case "pin": {
        const native: DocumentAnnotation = { id: crypto.randomUUID(), kind: "highlight", anchor, text: anchorText(model, anchor), comment: "", color: pen.color, style: pen.style, createdAt: new Date().toISOString() };
        void saveNotebookExcerpt(notebook, native.text, { locationLabel: anchorLabel(model, anchor), position: engine.unitForAnchor(anchor), native }); return;
      }
      case "delete": if (existing) changeAnnotations(annotations.filter((item) => item.id !== existing.id)); return;
    }
  });
  useEffect(() => {
    if (!pageOpened) return;
    let disposed = false, draining = false, again = false, unlisten: (() => void) | undefined;
    const drain = async () => {
      if (draining) { again = true; return; }
      draining = true;
      try {
        const { readPageInteraction } = await import("../web/browser");
        do {
          again = false;
          for (let i = 0; i < 8 && !disposed; i++) { const event = await readPageInteraction(pageOwner); if (!event) break; handlePageEvent(event); }
        } while (again && !disposed);
      } catch { /* A page that closed or navigated drops its queued actions. */ }
      finally { draining = false; }
    };
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ owner: string | null }>("knowbel-page-interaction", ({ payload }) => { if (payload.owner === pageOwner) void drain(); }))
      .then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => {});
    drainPage.current = () => void drain();
    return () => { disposed = true; unlisten?.(); drainPage.current = null; };
  }, [pageOpened, pageOwner, handlePageEvent]);
  // Synthetic events can't pass the page's trusted-event check, so the
  // desktop smoke test drives this handler directly in development builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = window as unknown as { __knowbelPageEvent?: (event: PageInteraction) => void };
    target.__knowbelPageEvent = handlePageEvent;
    return () => { delete target.__knowbelPageEvent; };
  }, [handlePageEvent]);
  const exportDocument = useEvent(async (print = false) => {
    try {
      await flush();
      const { annotatedHTML, downloadAnnotatedHTML, printAnnotatedHTML } = await import("./export.ts");
      const html = await annotatedHTML(model, notebook.getNativeAnnotations(), notebook.getSnapshot(), notebook.getAssets());
      if (print) await printAnnotatedHTML(html); else downloadAnnotatedHTML(html, session.meta.title);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Couldn't export this document."); }
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const editing = (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]");
      const k = event.key.toLowerCase();
      if (mod && k === "p") { event.preventDefault(); void exportDocument(true); }
      else if (mod && event.altKey && k === "g") {
        event.preventDefault(); setNavigationFocusRequest((n) => n + 1);
      } else if (mod && ["f", "j", "o"].includes(k)) {
        event.preventDefault();
        if (k === "f") { setPanel("search"); searchRef.current?.focus(); }
        else if (k === "j") { setPanel("ask"); setAskFocus((n) => n + 1); }
        else fileRef.current?.click();
      } else if (mod && !editing && k === "z" && !event.shiftKey) {
        event.preventDefault(); notebook.undo(); closeTip();
      } else if (mod && !editing && ["=", "+", "-", "0"].includes(k)) {
        event.preventDefault(); setScale((scale) => k === "0" ? 100 : Math.max(70, Math.min(200, scale + (k === "-" ? -10 : 10))));
      } else if (mod && !editing && (k === "arrowleft" || k === "arrowright")) {
        event.preventDefault(); goHistory(k === "arrowleft" ? "back" : "forward");
      } else if (k === "escape") { closeTip(); setTool("select"); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [closeTip, model.id, openFile, writer, goHistory, notebook, exportDocument]);

  const notebookSections = useMemo(() => model.outline.map((heading, i) => ({ id: `source:${heading.blockId}:${i}`, title: heading.title, position: (engine.blockIndex.get(heading.blockId) ?? 0) + 1 })), [engine, model]);
  useEffect(() => { notebook.enrichCaptures((capture) => {
    if (!capture.native) return capture;
    const position = engine.unitForAnchor(capture.native.anchor), locationLabel = anchorLabel(model, capture.native.anchor);
    const conversationId = askStore.getSnapshot().find((thread) => thread.mode === "dive" && !thread.parentThreadId && thread.anchor && sameAnchor(thread.anchor, capture.native!.anchor))?.id;
    return capture.position === position && capture.locationLabel === locationLabel && capture.conversationId === conversationId ? capture : { ...capture, position, locationLabel, conversationId };
  }); }, [notebook, engine, model, annotations, askStore]);
  const askPanel = (<AskPanel reflowable store={askStore} getContext={getAskContext} hasDocument pageLabels={null} openThreadId={openThreadId} onOpenThread={setOpenThreadId}
          onJob={trackJob} onReturnToPassage={(thread) => { if (thread.anchor) goTo(thread.anchor); }}
          onDiveFromAnswer={diveFromAnswer}
          onJumpToSource={jumpSource} focusRequest={askFocus} attachments={attachments} onAddToQuestion={(kind, text) => { const attachment = makeAttachment(kind, text); if (attachment) startSelectionQuestion([attachment]); }}
          onRemoveAttachment={(id) => setAttachments((previous) => previous.filter((attachment) => attachment.id !== id))} onClearAttachments={() => setAttachments([])}
          onPin={(text, context) => void saveNotebookExcerpt(notebook, text, { context })} />);
  const selectedAnnotation = selection?.annotationId ? annotations.find((entry) => entry.id === selection.annotationId) : undefined;
  return <NotebookProvider value={{ store: notebook, getAskContext, pageLabel: (unit) => engine.labelForUnit(unit), onJumpToSource: jumpSource, onOpenCapture: (capture) => {
    if (capture.native) goTo(capture.native.anchor);
    else if (capture.dive && askStore.get(capture.dive.panelId)?.mode === "dive") { setDiveFocusId(capture.dive.panelId); setDiveHighlightFocusId(capture.dive.id); }
    else if (capture.sources?.[0]) jumpSource({ source: capture.sources[0], range: [capture.sources[0].start, capture.sources[0].end] });
    else showNotice("The original source location wasn’t recorded. Your saved excerpt is kept here.");
  }, onHoverCapture: (capture) => setHoveredAnnotationId(capture?.native?.id ?? null), onOpenConversation: (id, turnId) => { if (id.startsWith("glossary:")) { setPanel("glossary"); setGlossaryFocus({ entryId: id.slice(9), nonce: Date.now() }); return true; } const thread = askStore.get(id); if (!thread) return false; if (thread.mode === "dive") { setDiveFocusId(id); setPanel(null); } else { setOpenThreadId(id); setPanel("ask"); } setNotebookOpen(true); revealConversationTurn(turnId); return true; }, attachmentsForCapture: captureAttachments }}>
  <div className="app-shell native-reader" onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { if ((event.target as HTMLElement).closest(".notebook-dock")) return; if (event.dataTransfer.files.length) { event.preventDefault(); void openFile(event.dataTransfer.files[0]); } }}>
    <AppRail reflowable allowArea onHome={() => void leave().catch(() => showNotice("Couldn't save your reading position. Try again."))}
      activePanel={panel} notebookOpen={notebookOpen} onSelectPanel={(next) => { if (next === "annotations") setNotebookOpen((value) => !value); else { if (next === "ask") setNotebookOpen(true); setPanel((previous) => previous === next ? null : next); } }} tool={tool}
      onSelectTool={(next) => { if (pageMode && next === "area") { setPageMode(false); showNotice("Area capture uses Study text, where pictures are saved with the document."); } setTool((previous) => previous === next && next === "note" ? "select" : next); }} pen={pen}
      onPenChange={(next) => { setPen(next); try { localStorage.setItem("highlight-pen", JSON.stringify(next)); } catch { /* session preference */ } }}
      view={{ reflowable: true, zoomLabel: `${scale}%`, currentZoomPercent: () => scale, minZoomPercent: 70, maxZoomPercent: 200,
        onZoomIn: () => setScale((n) => Math.min(200, n + 10)), onZoomOut: () => setScale((n) => Math.max(70, n - 10)),
        onZoomFit: () => setScale(100), onZoomSet: (n) => setScale(Math.max(70, Math.min(200, n))),
        twoPageView: false, continuousScroll: true, onToggleTwoPageView: () => {}, onToggleContinuousScroll: () => {},
        notesCollapsed, onToggleNotesCollapsed: () => setNotesCollapsed((value) => !value), theme, onToggleTheme: toggleTheme,
        footer: <><div className="rail-popover-separator" />
          {sourceUrl && /^https?:/i.test(sourceUrl) && safeDocumentUrl(sourceUrl) ? <button type="button" className="view-menu-action" title={sourceUrl} onClick={() => void openExternal(sourceUrl)}>Open original page</button> : null}
          <button type="button" className="view-menu-action" onClick={() => void exportDocument()}>Export annotated HTML</button>
          <button type="button" className="view-menu-action" onClick={() => void exportDocument(true)}>Print / Save as PDF</button></> }} />
    <input ref={fileRef} type="file" accept={DOCUMENT_FILE_ACCEPT} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void openFile(file); event.target.value = ""; }} />
    {panel && panel !== "ask" && panel !== "annotations" ? <SidebarFrame onClose={() => setPanel(null)}>
      <Suspense fallback={<p className="sidebar-empty" role="status">Loading…</p>}>
        {panel === "glossary" ? <GlossaryPanel store={glossary} pageLabels={null} focusRequest={glossaryFocus} onJumpToRef={jumpGlossary}
          onRetry={(id) => void runGlossaryJob(glossary, id, glossaryContext())} onDelete={(id) => { cancelGlossaryJob(id); glossary.remove(id); }}
          marksVisible={glossaryMarksVisible} onMarksVisibleChange={(visible) => { setGlossaryMarksVisible(visible); try { localStorage.setItem("glossary-marks-visible", String(visible)); } catch { /* session preference */ } }} /> :
        panel === "toc" ? <>
          <header className="sidebar-header"><h2>Contents</h2></header>
          <div className="sidebar-list flow-contents">
            {!model.outline.length ? <p className="sidebar-empty">No headings in this document.</p> : model.outline.map((heading) =>
              <button type="button" key={heading.blockId} style={{ paddingLeft: `${12 + (heading.depth - 1) * 12}px` }} onClick={() => {
                const block = model.blocks[engine.blockIndex.get(heading.blockId)!];
                goTo(textAnchor(model, { blockId: block.id, offset: 0 }, { blockId: block.id, offset: block.text.length }));
              }}>{heading.title}</button>)}
            {model.objects.length ? <><h3>Images and tables</h3>{model.objects.map((object) => <button key={`${object.blockId}-${object.id}`} type="button"
              onClick={() => goTo({ kind: "object", objectId: object.id, blockId: object.blockId })}>{object.kind === "table" ? "▦" : "▧"} {object.label}</button>)}</> : null}
          </div></> :
        panel === "search" ? <>
          <header className="sidebar-header"><h2>Search</h2></header>
          <div className="flow-search"><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search document" aria-label="Search document" /></div>
          <div className="sidebar-list flow-results">
            {deferredQuery.trim() ? <p className="sidebar-hint">{searchMatches.length === 200 ? "First 200" : searchMatches.length} matches</p> : <p className="sidebar-empty">Search the document’s text.</p>}
            {searchMatches.map((match, index) => <button type="button" key={index} onClick={() => goTo(match.anchor)}><small>{anchorLabel(model, match.anchor)}</small>
              {match.before}<mark>{match.match}</mark>{match.after}</button>)}
          </div></> : null}

      </Suspense>
    </SidebarFrame> : null}
    {hoveredAnnotationId ? <style>{`.native-reader [data-annotation-id="${CSS.escape(hoveredAnnotationId)}"] { box-shadow: 0 0 0 2px var(--rphp-accent, #5b50e6); }`}</style> : null}
    <div className="app-main native-workspace">
      {diveFocusId ? <Suspense fallback={<p className="reader-loading">Opening Deep Dive…</p>}><NativeDiveView store={askStore} engine={engine} notebook={notebook} getContext={getAskContext} controllers={session.diveControllers}
        focusId={diveFocusId} onFocus={setDiveFocusId} onReturn={(id) => { const thread = askStore.get(id); setDiveFocusId(id); if (thread?.anchor) goTo(thread.anchor); }} rootSlotRef={diveSlotRef}
        onJumpToSource={jumpSource} onJob={trackJob} highlightFocusId={diveHighlightFocusId} /></Suspense> : <div className="native-source-slot" ref={workspaceSlotRef} />}
    </div>
    <PersistentFlowPane workspace={workspaceSlotRef} dive={diveSlotRef} focused={diveFocusId}>
    <main className="app-main flow-pane native-source-pane">
      {canShowPage && pageUrl ? <div className="web-document-toolbar">
        <div className="web-document-modes" role="group" aria-label="Document view">
          <button type="button" aria-pressed={pageMode} title="The original web page, with its own styles and interactive content" onClick={() => { closeTip(); setNavigate(null); setPageOpened(true); setPageMode(true); if (tool === "area") setTool("select"); }}>Page</button>
          <button type="button" aria-pressed={!pageMode} title="The saved copy: reflowing text that works offline" onClick={() => setPageMode(false)}>Study text</button>
        </div>
        <small>{!pageMode ? "Study text · works offline" : pageSource === "saved" ? `Saved page${archivedAt ? ` from ${new Date(archivedAt).toLocaleDateString()}` : ""} · offline` : pageStalled ? "The live page isn't loading" + (archivedAt ? "" : " · Study text works offline") : "Live page · select text to highlight, ask or dive"}</small>
        {!pageMode ? null : pageSource === "saved" ? <button type="button" className="web-document-reload" title="Load the current page from the site" onClick={() => switchPageSource("live")}>Load live page</button> :
          pageStalled && archivedAt ? <button type="button" className="web-document-reload" title="Open the copy of this page saved for offline reading" onClick={() => switchPageSource("saved")}>Open saved page</button> :
          <button type="button" className="web-document-reload" title="Reload the page" onClick={() => void import("../web/browser").then(({ browserAction }) => browserAction(pageOwner, "reload")).catch((error) => showNotice(String(error)))}>Reload</button>}
      </div> : null}
      {pageOpened && pageUrl ? <div className="original-page-source" hidden={!pageMode}><Suspense fallback={<p>Loading original page…</p>}><EmbeddedPage url={pageUrl} owner={pageOwner} onReady={onPageReady} onLoading={onPageLoading} initialScroll={session.meta.view?.pageScroll} source={pageSource} loadArchive={loadArchive} /></Suspense></div> : null}
      <div className="native-study-source" hidden={pageMode}>
      <FlowView model={model} annotations={annotations} flash={flash} scale={scale} notesCollapsed={notesCollapsed} noteMode={tool === "note"}
        areaMode={tool === "area"} onArea={captureArea}
        references={references} onReference={showReference}
        glossaryMarks={glossaryProjection.current.marks} onGlossary={showGlossary}
        onSelection={captureSelection} onSticker={placeSticker} onPosition={onPosition} navigate={navigate} onNavigate={goTo} />
      <SectionNavigator engine={engine} currentUnit={currentUnit} sequence={navigate?.sequence ?? 0}
        back={[...history.current.back].reverse()} forward={[...history.current.forward].reverse()}
        onBack={(steps) => goHistory("back", steps)} onForward={(steps) => goHistory("forward", steps)}
        onNavigate={goTo} focusRequest={navigationFocusRequest} />
      </div>
    </main>
    </PersistentFlowPane>
    <Suspense fallback={null}><NotebookDock open={notebookOpen || panel === "ask"} onClose={() => { setNotebookOpen(false); if (panel === "ask") setPanel(null); }} title={session.meta.title} currentPosition={currentUnit} sections={notebookSections} askSlot={panel === "ask" ? <SidebarFrame onClose={() => setPanel(null)}>{askPanel}</SidebarFrame> : null} onCloseAsk={() => setPanel(null)} /></Suspense>
    {referencePreview && !selection ? createPortal(<FloatingTip anchorRect={referencePreview.rect} onClose={() => setReferencePreview(null)}><div className="flow-reference-preview">{referencePreview.targets.map((target, index) => <div key={index}>
      <button type="button" onClick={() => { setReferencePreview(null); goTo(target.anchor); }}>{target.label} — Go to passage</button><FlowPreview model={model} anchor={target.anchor} />
    </div>)}</div></FloatingTip>, document.body) : null}
    {selection ? createPortal(<FloatingTip key={selection.annotationId ?? `${selection.anchor.kind}-${engine.unitForAnchor(selection.anchor)}`} anchorRect={selection.rect} onClose={closeTip} deps={[tipGlossaryId]}>
      {tipGlossaryId ? <Suspense fallback={<p role="status">Loading definition…</p>}><GlossaryCard store={glossary} entryId={tipGlossaryId}
        onOpenInGlossary={(entryId) => { setPanel("glossary"); setGlossaryFocus({ entryId, nonce: Date.now() }); closeTip(); }}
        onRetry={(id) => void runGlossaryJob(glossary, id, glossaryContext())} onJumpToRef={jumpGlossary} pageLabel={(unit) => engine.labelForUnit(unit)} /></Suspense> :
      <NativeSelectionTip onOpenNote={() => { const annotation = selectedAnnotation ?? saveAnnotation(selection.anchor, "highlight"); notebook.reveal(captureEntryId(`native:${annotation.id}`)); closeTip(); }} annotation={selectedAnnotation} text={anchorText(model, selection.anchor)} pen={pen}
        onSave={(comment, color, style) => {
          if (selectedAnnotation) changeAnnotations(annotations.map((item) => item.id === selectedAnnotation.id ? { ...item, comment, color, style } : item));
          else { saveAnnotation(selection.anchor, "highlight", comment, color, style); closeTip(); window.getSelection()?.removeAllRanges(); }
        }} onDelete={() => { if (selectedAnnotation) changeAnnotations(annotations.filter((item) => item.id !== selectedAnnotation.id)); closeTip(); }}
        onPaper={(paper) => { if (selectedAnnotation) changeAnnotations(annotations.map((item) => item.id === selectedAnnotation.id ? { ...item, paper } : item)); }}
        diveId={selectedAnnotation ? linkedDiveId(selectedAnnotation.id) : undefined} onOpenDive={openSavedDive}
        onDive={() => dive(selection.anchor)} onAddToQuestion={() => addToQuestion(selection.anchor)}
        onPin={() => { const anchor = selection.anchor; void saveNotebookExcerpt(notebook, anchorText(model, anchor), { locationLabel: anchorLabel(model, anchor), position: engine.unitForAnchor(anchor), native: { id: crypto.randomUUID(), kind: "highlight", anchor, text: anchorText(model, anchor), comment: "", color: pen.color, style: pen.style, createdAt: new Date().toISOString() } }); closeTip(); }}
        onGlossary={() => { const id = addGlossaryTerm(glossary, anchorText(model, selection.anchor), engine.unitForAnchor(selection.anchor), glossaryContext()); if (id) setTipGlossaryId(id); }} />}
    </FloatingTip>, document.body) : null}
  </div></NotebookProvider>;
}

function NativeSelectionTip({ onOpenNote, annotation, text, pen, onSave, onDelete, onPaper, diveId, onOpenDive, onDive, onAddToQuestion, onPin, onGlossary }: {
  onOpenNote: () => void; annotation?: DocumentAnnotation; text: string; pen: HighlightPen;
  diveId?: string; onOpenDive: (id: string) => void;
  onSave: (comment: string, color: string, style: DocumentAnnotation["style"]) => void;
  onDelete: () => void; onPaper: (paper: string) => void; onDive: () => void; onAddToQuestion: () => void; onPin: () => void; onGlossary: () => void;
}) {
  const isSticker = annotation?.kind === "sticker";
  const [style, setStyle] = useState(annotation?.style ?? pen.style);
  const ref = useRef<HTMLDivElement>(null);
  const note = { panel: null, button: <button type="button" className="TextHighlight__comment-button" onClick={onOpenNote}>Note</button> };
  return <div ref={ref} className="flow-selection-tip">
    <HighlightToolbar copyText={text} note={note} divePanelId={diveId} onOpenDive={onOpenDive} onStartDive={onDive} onAddToQuestion={onAddToQuestion}
      onAddToGlossary={text ? onGlossary : undefined} glossaryDisabledReason={isGlossaryCandidate(text) ? undefined : "Select a term of up to eight words"}
      onPin={!annotation ? onPin : undefined} onDelete={annotation ? onDelete : undefined}
      activeStyle={style} onStyleChange={isSticker ? undefined : (next) => { setStyle(next); if (annotation) onSave(annotation.comment, annotation.color, next); }}
      activeColor={annotation?.color} onColorChange={isSticker ? undefined : (color) => onSave(annotation?.comment ?? "", color, style)} />
    {isSticker ? <div className="flow-sticker-papers">{STICKER_PAPER_PRESETS.map((paper) => <button key={paper} type="button" title={STICKER_PAPER_NAMES[paper]} aria-label={STICKER_PAPER_NAMES[paper]}
      aria-pressed={(annotation.paper ?? STICKER_DEFAULT_PAPER) === paper} className={paper === "transparent" ? "flow-sticker-paper--clear" : undefined}
      style={{ background: paper }} onClick={() => onPaper(paper)}>{(annotation.paper ?? STICKER_DEFAULT_PAPER) === paper ? "✓" : null}</button>)}</div> : null}
  </div>;
}
