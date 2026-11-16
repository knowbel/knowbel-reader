import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, BookOpen, Check, Copy, MoreHorizontal, Plus, Search, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { useNotebook } from "./context";
import type { NotebookCapture, NotebookEntry, NotebookSection } from "./model";
import { emptyBody, hasRichContent, newExchange } from "./model";
import RichEditor, { RichContent } from "./RichEditor";
import { entryMarkdown, notebookMarkdown, exportNotebook, readNotebookBundle } from "./export";
import { showNotice } from "../components/notices";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import { notebookView, rememberNotebookView } from "./view";
import "./notebook.css";

interface DockProps { open: boolean; onClose: () => void; title: string; currentPosition: number; sections: NotebookSection[]; askSlot?: ReactNode; onCloseAsk?: () => void }
type ObserveEntry = (element: Element, reveal: () => void) => () => void;
const VisibilityContext = createContext<ObserveEntry>(() => () => {});
function captureKind(capture: NotebookCapture): string {
  if (capture.kind === "dive" || (capture.kind === "excerpt" && capture.conversationId)) return "AI excerpt";
  if (capture.pdf?.type === "freetext" || capture.native?.kind === "sticker") return "Sticky note";
  if (capture.imageId || capture.native?.anchor.kind === "object") return "Figure or region";
  return "Highlight";
}
const SourceExcerpt = memo(function SourceExcerpt({ capture, previewOnly = false }: { capture: NotebookCapture; previewOnly?: boolean }) {
  const bindings = useNotebook()!;
  const [expanded, setExpanded] = useState(false);
  const label = capture.locationLabel ?? (capture.position ? `p. ${bindings.pageLabel(capture.position)}` : capture.conversationId ? "From an AI explanation" : "Source not recorded");
  return <div className="nb-source" style={{ "--nb-source-color": capture.pdf?.highlightColor ?? capture.native?.color ?? capture.dive?.highlightColor ?? "var(--border-strong)" } as CSSProperties} onMouseEnter={() => bindings.onHoverCapture?.(capture)} onMouseLeave={() => bindings.onHoverCapture?.(null)}>
    <div className="nb-source-meta"><span>{captureKind(capture)}</span><button type="button" className="nb-source-link" onClick={() => bindings.onOpenCapture(capture)} title="Show source">{label}</button>
      {capture.conversationId && bindings.onOpenConversation ? <button type="button" onClick={() => { if (!bindings.onOpenConversation!(capture.conversationId!, capture.turnId)) showNotice("The conversation is no longer available. Your saved excerpt is kept here."); }}>Conversation</button> : null}</div>
    {capture.imageId ? <img loading="lazy" src={bindings.store.assetUrl(capture.imageId)} alt="Saved source region" /> : null}
    {capture.text && (!previewOnly || expanded) ? <blockquote className={expanded ? "is-expanded" : ""}>{capture.snapshotRich ? <RichContent node={capture.snapshotRich} entryId={`source:${capture.id}`} /> : capture.text.includes('$') || capture.kind === "dive" ? <AnswerMarkdown content={capture.text} sources={capture.sources ?? []} pageLabel={bindings.pageLabel} onJump={bindings.onJumpToSource} /> : capture.text}</blockquote> : null}
    {capture.text && (capture.text.length > 240 || previewOnly || capture.snapshotRich) ? <button type="button" className="nb-quiet" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : previewOnly ? "Preview original" : "Show more"}</button> : null}
    {capture.context && !capture.conversationId ? <span className="nb-source-context">{capture.context}</span> : null}
  </div>;
});

const Entry = memo(function Entry({ entry, active, onActivate, onFinish, selecting, selected, onSelect, trash }: { entry: NotebookEntry; active: boolean; onActivate: (id: string) => void; onFinish: () => void; selecting: boolean; selected: boolean; onSelect: (id: string) => void; trash: boolean }) {
  const bindings = useNotebook()!, store = bindings.store;
  const [related, setRelated] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const entryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active || trash) return;
    let pointerDown = false;
    const startPointer = () => { pointerDown = true; };
    const endPointer = () => { pointerDown = false; };
    const finishOutside = (event: Event) => {
      if (event.type === 'focusin' && pointerDown) return;
      if (event.target instanceof Node && !entryRef.current?.contains(event.target)) onFinish();
    };
    // Include non-focusable surfaces, while keeping every control within the
    // note in the editor. Wait for the click so collapsing this note cannot
    // shift another note or control out from under the pointer.
    document.addEventListener('pointerdown', startPointer, true);
    document.addEventListener('pointerup', endPointer, true);
    document.addEventListener('pointercancel', endPointer, true);
    document.addEventListener('click', finishOutside, true);
    document.addEventListener('focusin', finishOutside, true);
    return () => {
      document.removeEventListener('pointerdown', startPointer, true);
      document.removeEventListener('pointerup', endPointer, true);
      document.removeEventListener('pointercancel', endPointer, true);
      document.removeEventListener('click', finishOutside, true);
      document.removeEventListener('focusin', finishOutside, true);
    };
  }, [active, trash, onFinish]);
  const captures = entry.captureIds.flatMap((id) => { const capture = store.getCapture(id); return capture ? [capture] : []; });
  const written = hasRichContent(entry.body);
  const relevant = related ? store.getSnapshot().entries.filter((other) => other.id !== entry.id && !other.deletedAt).map((other) => {
    const shared = other.captureIds.filter((id) => entry.captureIds.includes(id)).length;
    const terms = new Set((store.plain(entry) + captures.map((capture) => capture.text).join(' ')).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    const words = new Set(store.plain(other).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    return { other, shared, score: shared * 20 + [...terms].filter((word) => words.has(word)).length };
  }).filter((item) => item.score > 1).sort((a, b) => b.score - a.score).slice(0, 3) : [];
  return <article ref={entryRef} className={`nb-entry${active ? " is-editing" : ""}${selected ? " is-selected" : ""}`} data-entry-id={entry.id} tabIndex={0} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" && !trash) { event.preventDefault(); onActivate(entry.id); }
  }}>
    <div className="nb-entry-meta">
      {selecting ? <input type="checkbox" aria-label="Select note" checked={selected} onChange={() => onSelect(entry.id)} /> : null}
      <span className="nb-entry-label">{entry.origin ? "AI-assisted" : captures.length ? "" : "Note"}</span>
      {entry.origin ? <span className="nb-source-context" title={entry.origin.context}>Saved explanation</span> : null}
      <span className="nb-spacer" />
      {trash ? <button type="button" onClick={() => store.restore(entry.id)}>Restore</button> : <details className="nb-entry-menu" onToggle={(event) => setMenuOpen(event.currentTarget.open)}><summary aria-label="Note actions" title="Note actions"><MoreHorizontal size={15} /></summary><div className="nb-menu">
        <button type="button" onClick={() => onActivate(entry.id)}>Edit note</button>
        <button type="button" onClick={() => { const next = newExchange(); store.updateBody(entry.id, { ...entry.body, content: [...(entry.body.content ?? []), next, { type: "paragraph" }] }); onActivate(entry.id); }}>Ask AI here</button>
        <button type="button" onClick={() => setRelated((value) => !value)}>Related notes</button>
        <button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(entryMarkdown(entry, store.getSnapshot())); showNotice("Note copied as Markdown."); } catch { showNotice("Couldn't copy the note."); }
        }}><Copy size={13} /> Copy as Markdown</button>
        <label>Move to<select aria-label="Move note to section" value={store.sectionFor(entry)} onChange={(event) => store.move(entry.id, event.target.value)}>{store.getSnapshot().sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>
        <label>Attach a saved passage<select aria-label="Attach a saved passage" value="" onChange={(event) => { if (event.target.value) store.attachCapture(entry.id, event.target.value); }}><option value="">Choose a passage…</option>{(menuOpen ? store.getSnapshot().captures : []).filter((capture) => !entry.captureIds.includes(capture.id) && store.entryForCapture(capture.id)).map((capture) => <option key={capture.id} value={capture.id}>{capture.locationLabel ?? (capture.position ? `p. ${capture.position}` : captureKind(capture))} · {capture.text.slice(0, 65) || 'Image or note'}</option>)}</select></label>
        <button type="button" onClick={() => store.reorder(entry.id, -1)}><ArrowUp size={13} /> Move up</button><button type="button" onClick={() => store.reorder(entry.id, 1)}><ArrowDown size={13} /> Move down</button>
        <button type="button" className="nb-danger" onClick={() => { store.trash(entry.id); showNotice("Note moved to Trash."); }}><Trash2 size={13} /> Move to Trash</button>
      </div></details>}
    </div>
    {captures.map((capture) => <SourceExcerpt key={capture.id} capture={capture} previewOnly={!!entry.origin && !!written} />)}
    {active && !trash ? <RichEditor entryId={entry.id} body={entry.body} onChange={(body) => store.updateBody(entry.id, body)} autoFocus onFinish={onFinish} /> : written ? <div className="nb-entry-writing" onClick={(event) => {
      if (trash || (event.target as HTMLElement).closest("button,a,textarea,input,select,.nb-ai-exchange") || !window.getSelection()?.isCollapsed) return; onActivate(entry.id);
    }}><RichContent node={entry.body} entryId={entry.id} /></div> : !trash ? <button type="button" className="nb-write-here" onClick={() => onActivate(entry.id)}>Write a note…</button> : null}
    {related ? <div className="nb-related"><span className="nb-eyebrow">Related notes</span>{relevant.length ? relevant.map(({ other, shared }) => <button type="button" key={other.id} onClick={() => store.reveal(other.id)}><span>{store.plain(other).slice(0, 100) || store.getCapture(other.captureIds[0])?.text.slice(0, 100) || "Source excerpt"}</span><small>{shared ? "Same source" : "Related wording"}</small></button>) : <p>No closely related notes yet.</p>}</div> : null}
  </article>;
});

// One observer per dock, not one observer/editor per saved passage. Far-away
// entries reserve space without parsing math, rendering AI, or loading images.
const LazyEntry = memo(function LazyEntry(props: ComponentProps<typeof Entry> & { eager: boolean }) {
  const observe = useContext(VisibilityContext), ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(props.eager);
  useEffect(() => {
    if (seen || props.active || !ref.current) return;
    return observe(ref.current, () => setSeen(true));
  }, [observe, seen, props.active]);
  const visible = seen || props.active || props.selected;
  return <div ref={ref} className="nb-entry-shell" data-entry-id={props.entry.id}>{visible ? <Entry {...props} /> : <div className="nb-entry-placeholder" tabIndex={0} aria-label="Saved note" onFocus={() => setSeen(true)} onKeyDown={(event) => { if (event.key === 'Enter') props.onActivate(props.entry.id); }} />}</div>;
});

export default function NotebookDock({ open, onClose, title, currentPosition, sections, askSlot, onCloseAsk }: DockProps) {
  const bindings = useNotebook()!, store = bindings.store;
  const doc = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const saveState = useSyncExternalStore(store.subscribe, store.getSaveState);
  const request = useSyncExternalStore(store.subscribe, () => store.focusRequest);
  const restored = useMemo(() => notebookView(store.docId), [store]);
  const [query, setQuery] = useState(restored.query ?? ""), deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState(restored.filter ?? "all"), [trash, setTrash] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() => restored.activeId && store.getEntry(restored.activeId) && !store.getEntry(restored.activeId)!.deletedAt ? restored.activeId : null);
  const [color, setColor] = useState(restored.color ?? ""), [sort, setSort] = useState(restored.sort ?? "manual");
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
  const [width, setWidth] = useState(() => { try { return Math.max(320, Math.min(640, Number(localStorage.getItem('knowbel-notebook-width')) || 420)); } catch { return 420; } });
  const [askHeight, setAskHeight] = useState(42);
  const [newMaterial, setNewMaterial] = useState<string | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null), importInput = useRef<HTMLInputElement>(null);
  const previousIds = useRef(new Set(doc.entries.map((entry) => entry.id)));
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const observer = useRef<IntersectionObserver | null>(null);
  const observed = useRef(new Map<Element, () => void>());
  const observe = useCallback<ObserveEntry>((element, reveal) => {
    observed.current.set(element, reveal); observer.current?.observe(element);
    return () => { observed.current.delete(element); observer.current?.unobserve(element); };
  }, []);
  useEffect(() => {
    const next = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { observed.current.get(entry.target)?.(); next.unobserve(entry.target); }
    }, { root: listRef.current, rootMargin: '500px 0px' });
    observer.current = next; for (const element of observed.current.keys()) next.observe(element);
    return () => { next.disconnect(); observer.current = null; };
  }, []);
  useEffect(() => {
    const closeMenus = (event: PointerEvent | KeyboardEvent) => {
      const target = event.target as HTMLElement;
      for (const details of dockRef.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []) if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : !details.contains(target)) details.open = false;
    };
    document.addEventListener('pointerdown', closeMenus); document.addEventListener('keydown', closeMenus);
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', closeMenus); };
  }, []);
  useEffect(() => { store.setSections(sections); }, [sections, store]);
  useEffect(() => { rememberNotebookView(store.docId, { query, filter, activeId, color, sort }); }, [store, query, filter, activeId, color, sort]);
  useEffect(() => {
    const list = listRef.current;
    if (list && restored.scrollTop) list.scrollTop = restored.scrollTop;
    return () => { clearTimeout(scrollTimer.current); if (list) rememberNotebookView(store.docId, { scrollTop: list.scrollTop }); };
  }, [store, restored]);
  useEffect(() => { try { localStorage.setItem('knowbel-notebook-width', String(width)); } catch { /* optional view preference */ } }, [width]);
  useEffect(() => {
    if (!request) return;
    setTrash(false); setFilter('all'); setQuery(''); setColor(''); setNewMaterial(null); setActiveId(request.id);
    const frame = requestAnimationFrame(() => listRef.current?.querySelector(`[data-entry-id="${CSS.escape(request.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [request]);
  useEffect(() => {
    const added = doc.entries.filter((entry) => !entry.deletedAt && !previousIds.current.has(entry.id));
    if (added.length && (activeId || query || color || filter !== 'all' || color) && request?.id !== added.at(-1)!.id) setNewMaterial(added.at(-1)!.id);
    previousIds.current = new Set(doc.entries.map((entry) => entry.id));
  }, [doc.entries, activeId, query, filter, color, request]);
  const activate = useCallback((id: string) => setActiveId(id), []);
  const finish = useCallback(() => {
    if (activeId) store.finishEntry(activeId);
    setActiveId(null);
    // Flush now; storage errors remain visible through the dock's save status.
    void store.flush().catch(() => {});
  }, [store, activeId]);
  const choose = useCallback((id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]), []);
  const groups = useMemo(() => {
    const terms = deferredQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const groups = new Map<string, NotebookEntry[]>();
    const currentSection = store.sectionFor({ position: currentPosition, sectionId: null, captureIds: [] } as unknown as NotebookEntry);
    for (const entry of doc.entries) {
      if (!!entry.deletedAt !== trash) continue;
      const captures = entry.captureIds.flatMap((id) => { const capture = store.getCapture(id); return capture ? [capture] : []; });
      if (color && !captures.some((capture) => (capture.pdf?.highlightColor ?? capture.native?.color ?? capture.dive?.highlightColor) === color)) continue;
      if (filter === 'written' && !store.plain(entry).trim()) continue;
      if (filter === 'highlights' && !captures.some((capture) => capture.kind === 'pdf' || capture.kind === 'native')) continue;
      if (filter === 'ai' && !JSON.stringify(entry.body).includes('"contribution"') && !entry.origin && !captures.some((capture) => capture.kind === 'dive') && !entry.body.content?.some((node) => node.type === 'aiExchange')) continue;
      if (filter === 'images' && !captures.some((capture) => capture.imageId) && !JSON.stringify(entry.body).includes('"image"')) continue;
      const sectionId = store.sectionFor(entry);
      if (filter === 'nearby' && sectionId !== currentSection) continue;
      if (terms.length) { const haystack = [store.plain(entry), ...captures.flatMap((capture) => [capture.text, capture.context, capture.locationLabel])].join(' ').toLowerCase(); if (!terms.every((term) => haystack.includes(term))) continue; }
      if (!groups.has(sectionId)) groups.set(sectionId, []); groups.get(sectionId)!.push(entry);
    }
    return doc.sections.flatMap((section) => {
      const entries = groups.get(section.id); if (!entries) return [];
      if (sort === 'newest') entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (sort === 'location') entries.sort((a, b) => (a.position ?? capturesPosition(a)) - (b.position ?? capturesPosition(b)));
      return [{ section, entries }];
    });
    function capturesPosition(entry: NotebookEntry) { return entry.captureIds.map((id) => store.getCapture(id)?.position).find((position) => position !== undefined) ?? Infinity; }
  }, [doc, store, filter, deferredQuery, currentPosition, trash, color, sort]);
  const add = (ai = false) => { const id = store.addNote(null, currentPosition, ai ? { type: 'doc', content: [newExchange(), { type: 'paragraph' }] } : emptyBody()); store.reveal(id); };
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX, original = width;
    const target = event.currentTarget;
    const move = (event: Event) => setWidth(Math.max(320, Math.min(Math.min(640, window.innerWidth - 440), original + start - (event as PointerEvent).clientX)));
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end, { once: true });
  };
  const startAskResize = (event: React.PointerEvent) => {
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget, start = event.clientY, original = askHeight;
    const height = Math.max(1, dockRef.current?.clientHeight ?? 1);
    const move = (event: Event) => setAskHeight(Math.max(25, Math.min(75, original + (start - (event as PointerEvent).clientY) / height * 100)));
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end, { once: true }); target.addEventListener('pointercancel', end, { once: true });
  };
  const colors = [...new Set(doc.captures.map((capture) => capture.pdf?.highlightColor ?? capture.native?.color ?? capture.dive?.highlightColor).filter((value): value is string => !!value))];
  const exportDoc = { ...doc, entries: doc.entries.map((entry) => ({ ...entry, sectionId: store.sectionFor(entry) })) };
  return <aside ref={dockRef} onClick={(event) => { const button = (event.target as HTMLElement).closest(".nb-header-menu .nb-menu button"); const details = button?.closest("details"); if (details) details.open = false; }} className={`notebook-dock${open ? ' is-open' : ''}`} aria-label="Notebook" hidden={!open} style={{ '--notebook-width': `${width}px`, '--nb-ask-height': `${askHeight}%` } as CSSProperties}>
    <div className="nb-resize-handle" role="separator" aria-label="Resize notebook" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={640} aria-valuenow={width} tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth((value) => Math.max(320, Math.min(640, value + (event.key === 'ArrowLeft' ? 24 : -24)))); } }} />
    <header className="nb-header"><div><h2>Notebook</h2><span className={`nb-save-state is-${saveState}`} role="status">{saveState === 'saved' ? <><Check size={11} /> Saved</> : saveState === 'saving' ? 'Saving…' : <button type="button" onClick={() => void store.flush().catch(() => showNotice('Your changes are still kept here. Storage could not be written.'))}>Couldn’t save · Retry</button>}</span></div>
      <button type="button" className="nb-icon" title="New note" aria-label="New note" onClick={() => add()}><Plus size={17} /></button>
      <details className="nb-header-menu"><summary aria-label="Notebook actions"><MoreHorizontal size={17} /></summary><div className="nb-menu">
        <button type="button" onClick={() => add(true)}><Sparkles size={14} /> Ask AI here</button>
        <button type="button" onClick={() => setSectionTitle('')}>New section</button>
        <label>Sort notes<select aria-label="Sort notebook" value={sort} onChange={(event) => setSort(event.target.value)}><option value="manual">Notebook order</option><option value="location">Source location</option><option value="newest">Newest first</option></select></label>
        <label>Highlight color<select aria-label="Filter highlight color" value={color} onChange={(event) => setColor(event.target.value)}><option value="">All colors</option>{colors.map((value, index) => <option key={value} value={value}>{({ '#ffe08a': 'Yellow', '#b5e8b0': 'Green', '#a8d4ff': 'Blue', '#f5b5d4': 'Pink' } as Record<string, string>)[value] ?? `Color ${index + 1} (${value})`}</option>)}</select></label>
        <button type="button" onClick={() => { setSelecting((value) => !value); setSelected([]); }}>Select notes</button>
        <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(notebookMarkdown(exportDoc, title)); showNotice('Notebook copied as Markdown.'); } catch { showNotice('Couldn’t copy the notebook.'); } }}>Copy as Markdown</button>
        <button type="button" onClick={() => exportNotebook(exportDoc, store.getAssets(), title)}>Export Markdown</button>
        <button type="button" onClick={() => exportNotebook(exportDoc, store.getAssets(), title, true)}>Export complete notebook</button>
        <button type="button" onClick={() => void import("./htmlExport").then(({ exportNotebookHTML }) => exportNotebookHTML(exportDoc, store.getAssets(), title))}>Export HTML</button>
        <button type="button" onClick={() => importInput.current?.click()}>Import notebook</button>
        <button type="button" onClick={() => store.undo()}><Undo2 size={14} /> Undo notebook action</button>
        <button type="button" onClick={() => { setTrash((value) => !value); setActiveId(null); }}><Trash2 size={14} /> {trash ? 'Return to notes' : 'Trash'}</button>
      </div></details>
      <button type="button" className="nb-icon" title="Close notebook" aria-label="Close notebook" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="nb-search"><Search size={14} /><input type="search" aria-label="Search notebook" placeholder="Find in notebook…" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="Filter notebook" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Everything</option><option value="written">Written notes</option><option value="highlights">Highlights</option><option value="ai">AI material</option><option value="images">Images</option><option value="nearby">Near this passage</option></select></div>
    {trash ? <div className="nb-context-bar"><Trash2 size={13} /> Trash <button type="button" onClick={() => setTrash(false)}>Return to notes</button></div> : <div className="nb-context-bar"><BookOpen size={13} /><button type="button" title="Show notes near the reading position" onClick={() => { setFilter('nearby'); setQuery(''); }}>{doc.sections.find((section) => section.id === store.sectionFor({ position: currentPosition, sectionId: null, captureIds: [] } as unknown as NotebookEntry))?.title ?? 'Document notes'}</button></div>}
    {sectionTitle !== null ? <form className="nb-insert-form" onSubmit={(event) => { event.preventDefault(); if (sectionTitle.trim()) { const id = store.addSection(sectionTitle.trim()); const entryId = store.addNote(id); store.reveal(entryId); } setSectionTitle(null); }}><input autoFocus value={sectionTitle} onChange={(event) => setSectionTitle(event.target.value)} aria-label="Section name" placeholder="Section name" /><button type="submit">Add</button><button type="button" onClick={() => setSectionTitle(null)}>Cancel</button></form> : null}
    {selecting ? <div className="nb-selection-bar"><span>{selected.length} selected</span><button type="button" disabled={selected.length < 2} onClick={() => { const id = store.combine(selected); setSelected([]); setSelecting(false); if (id) store.reveal(id); }}>Combine</button><button type="button" onClick={() => { setSelecting(false); setSelected([]); }}>Done</button></div> : null}
    <VisibilityContext.Provider value={observe}><div className="nb-list" ref={listRef} onScroll={() => { clearTimeout(scrollTimer.current); scrollTimer.current = setTimeout(() => rememberNotebookView(store.docId, { scrollTop: listRef.current?.scrollTop ?? 0 }), 150); }}>
      {!groups.length ? <div className="nb-empty"><BookOpen size={26} /><p>{trash ? 'Trash is empty.' : query || color || filter !== 'all' ? 'No notes match this view.' : 'Keep what matters.'}</p><span>{trash ? 'Deleted notes can be restored here.' : query || color || filter !== 'all' ? 'Your other notes are still in the notebook.' : 'Highlight a passage, add an image, or start writing. Everything stays connected to its source.'}</span>{!trash ? <button type="button" onClick={() => query || color || filter !== 'all' ? (setQuery(''), setColor(''), setFilter('all')) : add()}>{query || color || filter !== 'all' ? 'Show everything' : 'Write your first note'}</button> : null}</div> : groups.map(({ section, entries }, groupIndex) => <section className="nb-section" key={section.id}><h3><span>{section.title}</span><small>{entries.length}</small></h3>{entries.map((entry, index) => <LazyEntry key={entry.id} entry={entry} eager={groupIndex === 0 && index < 8} active={entry.id === activeId} onActivate={activate} onFinish={finish} selecting={selecting} selected={selected.includes(entry.id)} onSelect={choose} trash={trash} />)}</section>)}
      {!trash && groups.length ? <button type="button" className="nb-add-note" onClick={() => add()}><Plus size={14} /> Write a note</button> : null}
    </div></VisibilityContext.Provider>
    {newMaterial ? <button type="button" className="nb-new-material" onClick={() => { store.reveal(newMaterial); setNewMaterial(null); }}>Show new material <ArrowDown size={12} /></button> : null}
    {askSlot ? <div className="nb-ask-area"><div role="separator" tabIndex={0} aria-label="Resize question area" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(askHeight)} onPointerDown={startAskResize} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setAskHeight((height) => Math.max(25, Math.min(75, height + (event.key === 'ArrowUp' ? 5 : -5)))); } }} className="nb-ask-resize" /><button type="button" className="nb-close-ask" aria-label="Close question area" onClick={onCloseAsk}><X size={14} /></button>{askSlot}</div> : null}
    <input ref={importInput} type="file" hidden accept=".zip" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { const bundle = await readNotebookBundle(file); store.importNotebook(bundle.document, bundle.assets); await store.flush(); showNotice('Notebook imported. Existing writing has been kept.'); } catch (error) { showNotice(error instanceof Error ? error.message : 'Couldn’t import the notebook.'); } }} />
  </aside>;
}
