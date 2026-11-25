import { useSyncExternalStore } from "react";
import type { SetStateAction } from "react";
import type { LibraryStorage } from "../storage/types.ts";
import type { CommentedHighlight } from "../types.ts";
import type { DocumentAnnotation } from "../document/model.ts";
import type { DiveHighlight } from "../deepdive/types.ts";
import { ReaderDraftStore } from "./drafts.ts";
import {
  aiContribution, hasRichContent, assetFromDataUrl, captureEntryId, dataUrl, emptyBody, findRichNode, interruptExchanges,
  isNotebook, mergeNotebookAssets, mergeNotebooks, migrateNotebook, newNotebook, patchRichNode, removeRichNode, richText, textBody,
  type NotebookAsset, type NotebookCapture, type NotebookDocument, type NotebookEntry,
  type NotebookLegacy, type NotebookSection, type RichNode,
} from "./model.ts";

export type SaveState = "saved" | "saving" | "error";
export interface EditorPatch { entryId: string; nodeId: string; attrs: Record<string, unknown> }
const changed = <T,>(action: SetStateAction<T>, current: T): T => typeof action === "function" ? (action as (previous: T) => T)(current) : action;
const now = () => new Date().toISOString();

export class NotebookStore {
  docId = "";
  drafts?: ReaderDraftStore;
  private doc = newNotebook("");
  private entries = new Map<string, NotebookEntry>();
  private captures = new Map<string, NotebookCapture>();
  private owners = new Map<string, string>();
  private assets: NotebookAsset[] = [];
  private assetMap = new Map<string, NotebookAsset>();
  private assetUrls = new Map<string, string>();
  private assetDataUrls = new Map<string, string>();
  private savedAssets: NotebookAsset[] | null = null;
  private listeners = new Set<() => void>();
  private markListeners = new Set<() => void>();
  private patchListeners = new Set<(patch: EditorPatch) => void>();
  private pdf: CommentedHighlight[] = [];
  private native: DocumentAnnotation[] = [];
  private dive: DiveHighlight[] = [];
  private savedRevision = -1;
  private saveState: SaveState = "saved";
  private timer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private journal = new Map<string, NotebookEntry>();
  private undoStack: { before: NotebookDocument; after: NotebookDocument }[] = [];
  private jobs = new Map<string, AbortController>();
  private plainCache = new WeakMap<RichNode, string>();
  private storage: LibraryStorage;
  focusRequest: { id: string; nonce: number } | null = null;
  onReveal?: () => void;
  onStickyTextChange?: (captureId: string, text: string) => void;

  constructor(storage: LibraryStorage) { this.storage = storage; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  subscribeMarks = (fn: () => void) => { this.markListeners.add(fn); return () => { this.markListeners.delete(fn); }; };
  subscribePatches = (fn: (patch: EditorPatch) => void) => { this.patchListeners.add(fn); return () => { this.patchListeners.delete(fn); }; };
  getSnapshot = () => this.doc;
  getSaveState = () => this.saveState;
  getPdfHighlights = () => this.pdf;
  getNativeAnnotations = () => this.native;
  getDiveHighlights = () => this.dive;
  getEntry = (id: string) => this.entries.get(id);
  getCapture = (id: string) => this.captures.get(id);
  getAssets = () => this.assets;
  importNotebook(document: NotebookDocument, assets: NotebookAsset[]) {
    if (document.docId !== this.docId) throw new Error("Open the source document this notebook belongs to before importing it.");
    const merged = mergeNotebookAssets(this.assets, assets, document);
    this.assets = merged.assets; this.assetMap = new Map(this.assets.map((asset) => [asset.id, asset]));
    this.commit(mergeNotebooks(this.doc, merged.document), true, true);
  }
  enrichCaptures(change: (capture: NotebookCapture) => NotebookCapture) {
    const captures = this.doc.captures.map(change);
    if (captures.some((capture, i) => capture !== this.doc.captures[i])) this.commit({ ...this.doc, captures }, true);
  }
  private emit() { this.listeners.forEach((fn) => fn()); }
  private recoveryKey() { return `knowbel-notebook-recovery:${this.docId}`; }

  async load(docId: string, data: NotebookLegacy & { notebook?: unknown; notebookAssets?: unknown; readerDrafts?: unknown }) {
    this.cancelJobs();
    if (this.docId) await this.flush();
    const migrated = !isNotebook(data.notebook);
    if (isNotebook(data.notebook) && data.notebook.docId !== docId) throw new Error("This notebook belongs to another document.");
    if (data.notebook && migrated) throw new Error("This notebook format isn't supported. Its original data has been kept.");
    // Prepare and acknowledge the new document before replacing the live
    // session. A failed migration must leave the current reader usable.
    const legacy = migrated ? migrateNotebook(docId, data) : null;
    let document = legacy?.notebook ?? data.notebook as NotebookDocument;
    const assets = [...new Map([...(Array.isArray(data.notebookAssets) ? data.notebookAssets as NotebookAsset[] : []), ...(legacy?.assets ?? [])].map((asset) => [asset.id, asset])).values()];
    const drafts = new ReaderDraftStore(this.storage, docId, data.readerDrafts, () => {
      if (this.docId !== docId) return;
      this.saveState = "saving"; clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush().catch(() => {}), 300); this.emit();
    });
    const recovered = new Map(document.entries.map((entry) => [entry.id, entry]));
    let didRecover = false;
    try {
      const journal = JSON.parse(localStorage.getItem(`knowbel-notebook-recovery:${docId}`) ?? "null") as { entries?: NotebookEntry[]; captures?: NotebookCapture[] } | null;
      for (const entry of journal?.entries ?? []) if (entry.id && entry.body && (!recovered.has(entry.id) || recovered.get(entry.id)!.updatedAt < entry.updatedAt)) { recovered.set(entry.id, entry); didRecover = true; }
      if (didRecover) {
        const captures = new Map(document.captures.map((capture) => [capture.id, capture]));
        for (const capture of journal?.captures ?? []) if (!captures.has(capture.id)) captures.set(capture.id, capture);
        document = { ...document, captures: [...captures.values()] };
      }
    } catch { /* durable notebook still opens if a recovery checkpoint is unreadable */ }
    const entries = [...recovered.values()].map((entry) => {
      const body = interruptExchanges(entry.body); if (body !== entry.body) didRecover = true;
      return body === entry.body ? entry : { ...entry, body };
    });
    if (didRecover) document = { ...document, revision: document.revision + 1, entries };
    if (migrated) await this.storage.putData(docId, "notebookAssets", assets);
    if (migrated || didRecover) await this.storage.putData(docId, "notebook", document);
    await drafts.flush();
    // Writing may continue in the current reader while migration is staged.
    if (this.docId) await this.flush();
    this.releaseUrls(); this.docId = docId; this.doc = document; this.assets = assets;
    this.assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    this.savedAssets = assets; this.savedRevision = document.revision; this.drafts = drafts;
    this.journal.clear(); this.undoStack = []; this.focusRequest = null; this.saveState = "saved";
    if (didRecover) try { localStorage.removeItem(this.recoveryKey()); } catch { /* optional checkpoint */ }
    this.reindex(); this.rebuildMarks(); this.emit();
  }
  private reindex() {
    this.entries = new Map(this.doc.entries.map((entry) => [entry.id, entry]));
    this.captures = new Map(this.doc.captures.map((capture) => [capture.id, capture]));
    this.owners.clear();
    for (const entry of this.doc.entries) if (!entry.deletedAt) for (const id of entry.captureIds) if (!this.owners.has(id)) this.owners.set(id, entry.id);
  }
  plain(entry: NotebookEntry | undefined): string {
    if (!entry) return "";
    let text = this.plainCache.get(entry.body);
    if (text === undefined) { text = richText(entry.body); this.plainCache.set(entry.body, text); }
    return text;
  }
  entryForCapture(id: string) { const owner = this.owners.get(id); return owner ? this.entries.get(owner) : undefined; }
  private captureBody(id: string) { return this.plain(this.entryForCapture(id)); }
  private rebuildMarks() {
    const pdf: CommentedHighlight[] = [], native: DocumentAnnotation[] = [], dive: DiveHighlight[] = [];
    for (const capture of this.doc.captures) {
      if (!capture.visible || !this.owners.has(capture.id)) continue;
      if (capture.pdf) {
        const source = capture.pdf;
        const content = { ...source.content, ...(capture.imageId ? { image: this.assetDataUrl(capture.imageId) } : {}) };
        if (source.type === "freetext") Object.defineProperty(content, "text", { enumerable: true, get: () => this.captureBody(capture.id) });
        const mark = { ...source, content };
        Object.defineProperty(mark, "comment", { enumerable: true, get: () => source.type === "freetext" ? undefined : this.captureBody(capture.id) });
        pdf.push(mark);
      } else if (capture.native) {
        const mark = { ...capture.native };
        Object.defineProperty(mark, "comment", { enumerable: true, get: () => this.captureBody(capture.id) });
        native.push(mark);
      } else if (capture.dive) {
        const mark = { ...capture.dive };
        Object.defineProperty(mark, "comment", { enumerable: true, get: () => this.captureBody(capture.id) });
        dive.push(mark);
      }
    }
    this.pdf = pdf; this.native = native; this.dive = dive;
    this.markListeners.forEach((fn) => fn());
  }
  private commit(doc: NotebookDocument, marks = false, undo = false) {
    const next = { ...doc, revision: this.doc.revision + 1 };
    if (undo) { this.undoStack.push({ before: this.doc, after: next }); if (this.undoStack.length > 100) this.undoStack.shift(); }
    this.doc = next;
    this.reindex();
    if (marks) this.rebuildMarks();
    this.saveState = "saving";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 300);
    this.emit();
  }
  checkpoint = () => {
    clearTimeout(this.checkpointTimer);
    if (!this.docId) return;
    if (!this.journal.size) { try { localStorage.removeItem(this.recoveryKey()); } catch { /* optional recovery */ } return; }
    const entries = [...this.journal.values()];
    const ids = new Set(entries.flatMap((entry) => entry.captureIds));
    try { localStorage.setItem(this.recoveryKey(), JSON.stringify({ entries, captures: this.doc.captures.filter((capture) => ids.has(capture.id)) })); } catch { /* acknowledged saves remain authoritative */ }
  };
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.checkpoint();
    if (!this.docId) return;
    if (this.saving) return this.saving;
    const save = this.persist(); this.saving = save;
    try { await save; }
    finally { if (this.saving === save) this.saving = undefined; this.emit(); }
  }
  private async persist(): Promise<void> {
    try {
      do {
        const snapshot = this.doc, assets = this.assets;
        if (this.savedRevision !== snapshot.revision || this.savedAssets !== assets || this.drafts?.isDirty()) { this.saveState = "saving"; this.emit(); }
        // Asset acknowledgement precedes any document that references it.
        if (this.savedAssets !== assets) { await this.storage.putData(this.docId, "notebookAssets", assets); this.savedAssets = assets; }
        if (this.savedRevision !== snapshot.revision) { await this.storage.putData(this.docId, "notebook", snapshot); this.savedRevision = snapshot.revision; }
        await this.drafts?.flush();
      } while (this.savedRevision !== this.doc.revision || this.savedAssets !== this.assets || this.drafts?.isDirty());
      this.saveState = "saved"; this.journal.clear();
      try { localStorage.removeItem(this.recoveryKey()); } catch { /* optional checkpoint */ }
    } catch (error) { this.saveState = "error"; this.checkpoint(); throw error; }
  }
  updateEntry(id: string, change: Partial<NotebookEntry>, structural = false) {
    const current = this.entries.get(id);
    if (!current || current.deletedAt) return;
    const entry = { ...current, ...change, updatedAt: now() };
    this.journal.set(id, entry);
    clearTimeout(this.checkpointTimer); this.checkpointTimer = setTimeout(this.checkpoint, 100);
    const sticky = entry.captureIds.some((captureId) => { const capture = this.captures.get(captureId); return capture?.pdf?.type === "freetext" || capture?.native?.kind === "sticker"; });
    this.commit({ ...this.doc, entries: this.doc.entries.map((item) => item.id === id ? entry : item) }, structural || sticky, structural);
    if (sticky && change.body) for (const captureId of entry.captureIds) if (this.captures.get(captureId)?.pdf?.type === "freetext") this.onStickyTextChange?.(captureId, this.plain(entry));
  }
  updateBody(id: string, body: RichNode) {
    const entry = this.entries.get(id); if (!entry || entry.body === body) return;
    // Deleting an active exchange cannot leave a streaming request detached.
    for (const [nodeId, controller] of this.jobs) if (findRichNode(entry.body, nodeId) && !findRichNode(body, nodeId)) { controller.abort(); this.jobs.delete(nodeId); }
    this.updateEntry(id, { body });
  }
  patchNode(entryId: string, nodeId: string, attrs: Record<string, unknown>) {
    const entry = this.entries.get(entryId);
    if (!entry || entry.deletedAt || !findRichNode(entry.body, nodeId)) return;
    this.updateBody(entryId, patchRichNode(entry.body, nodeId, attrs));
    this.patchListeners.forEach((fn) => fn({ entryId, nodeId, attrs }));
  }
  removeExchange(entryId: string, nodeId: string) {
    const entry = this.entries.get(entryId);
    if (!entry || entry.deletedAt || findRichNode(entry.body, nodeId)?.type !== "aiExchange") return;
    this.jobs.get(nodeId)?.abort(); this.jobs.delete(nodeId);
    this.updateEntry(entryId, { body: removeRichNode(entry.body, nodeId) }, true);
  }
  startJob(id: string) { this.jobs.get(id)?.abort(); const controller = new AbortController(); this.jobs.set(id, controller); return controller; }
  isCurrentJob(id: string, controller: AbortController) { return this.jobs.get(id) === controller; }
  stopJob(id: string) { this.jobs.get(id)?.abort(); }
  finishJob(id: string, controller: AbortController) { if (this.jobs.get(id) === controller) this.jobs.delete(id); }
  cancelJobs() {
    for (const [id, controller] of this.jobs) {
      controller.abort();
      for (const entry of this.doc.entries) if (findRichNode(entry.body, id)) this.patchNode(entry.id, id, { status: "interrupted", error: "Interrupted. Retry when you’re ready." });
    }
    this.jobs.clear();
  }
  reveal(id: string) { this.focusRequest = { id, nonce: Date.now() }; this.onReveal?.(); this.emit(); }
  addNote(sectionId: string | null = "document", position?: number, body = emptyBody()): string {
    const at = now(), id = crypto.randomUUID();
    const entry: NotebookEntry = { id, body, captureIds: [], sectionId, position, createdAt: at, updatedAt: at };
    this.journal.set(id, entry);
    this.commit({ ...this.doc, entries: [...this.doc.entries, entry] }, false, true);
    return id;
  }
  addExcerpt(text: string, options: Partial<NotebookCapture> = {}, body = emptyBody()): string {
    const same = this.doc.captures.find((capture) => capture.kind === "excerpt" && capture.text === text && capture.conversationId === options.conversationId && capture.turnId === options.turnId && capture.position === options.position && this.owners.has(capture.id));
    if (same) return this.owners.get(same.id)!;
    const capture: NotebookCapture = { ...options, id: crypto.randomUUID(), kind: "excerpt", text, visible: false };
    const at = now();
    const entry: NotebookEntry = { id: captureEntryId(capture.id), sectionId: null, position: capture.position, body, captureIds: [capture.id], createdAt: at, updatedAt: at,
      ...(capture.conversationId || capture.sources?.length ? { origin: { kind: "ai" as const, conversationId: capture.conversationId, turnId: capture.turnId, context: capture.context, sources: capture.sources ?? [] } } : {}) };
    if (entry.origin && hasRichContent(body)) entry.body = { type: "doc", content: [aiContribution(body, entry.origin), { type: "paragraph" }] };
    this.journal.set(entry.id, entry);
    this.commit({ ...this.doc, entries: [...this.doc.entries, entry], captures: [...this.doc.captures, capture] }, false, true);
    return entry.id;
  }
  setSections(sections: NotebookSection[]) {
    const next = [...this.doc.sections.filter((section) => section.custom || section.id === "document"), ...sections.filter((section) => section.id !== "document")];
    if (JSON.stringify(next) === JSON.stringify(this.doc.sections)) return;
    this.commit({ ...this.doc, sections: next });
  }
  addSection(title: string) { const id = `custom:${crypto.randomUUID()}`; this.commit({ ...this.doc, sections: [...this.doc.sections, { id, title, custom: true }] }, false, true); return id; }
  sectionFor(entry: NotebookEntry): string {
    if (entry.sectionId && this.doc.sections.some((section) => section.id === entry.sectionId)) return entry.sectionId;
    const position = entry.position ?? entry.captureIds.map((id) => this.captures.get(id)?.position).find((position) => position !== undefined);
    if (position === undefined) return "document";
    let found = "document";
    for (const section of this.doc.sections) if (section.position !== undefined && section.position <= position) found = section.id;
    return found;
  }
  attachCapture(entryId: string, captureId: string) {
    const entry = this.entries.get(entryId);
    if (entry && this.captures.has(captureId) && !entry.captureIds.includes(captureId)) this.updateEntry(entryId, { captureIds: [...entry.captureIds, captureId] }, true);
  }
  move(id: string, sectionId: string) { this.updateEntry(id, { sectionId }, true); }
  reorder(id: string, delta: number) {
    const entry = this.entries.get(id); if (!entry) return;
    const same = this.doc.entries.filter((item) => !item.deletedAt && this.sectionFor(item) === this.sectionFor(entry));
    const at = same.findIndex((item) => item.id === id), other = same[at + delta]; if (!other) return;
    const entries = [...this.doc.entries], a = entries.indexOf(entry), b = entries.indexOf(other);
    [entries[a], entries[b]] = [entries[b], entries[a]];
    this.commit({ ...this.doc, entries }, false, true);
  }
  combine(ids: string[]): string | undefined {
    const selected = this.doc.entries.filter((entry) => ids.includes(entry.id) && !entry.deletedAt); if (selected.length < 2) return;
    const first = selected[0], at = now();
    // Keep each contribution's origin with its own body block.
    const content = selected.flatMap((entry) => entry.origin && !entry.body.content?.some((node) => node.type === "contribution") ? [aiContribution(entry.body, entry.origin)] : entry.body.content ?? []);
    const merged = { ...first, origin: undefined, body: { type: "doc", content }, captureIds: [...new Set(selected.flatMap((entry) => entry.captureIds))], updatedAt: at };
    const entries = this.doc.entries.map((entry) => entry.id === first.id ? merged : ids.includes(entry.id) ? { ...entry, deletedAt: at } : entry);
    this.commit({ ...this.doc, entries }, true, true); return first.id;
  }
  finishEntry(id: string) {
    const entry = this.entries.get(id);
    if (entry && !entry.captureIds.length && !hasRichContent(entry.body)) {
      this.journal.delete(id);
      this.commit({ ...this.doc, entries: this.doc.entries.filter((item) => item.id !== id) });
      this.checkpoint();
    }
  }
  trash(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    const at = now();
    for (const [nodeId, controller] of this.jobs) if (findRichNode(entry.body, nodeId)) controller.abort();
    this.commit({ ...this.doc, entries: this.doc.entries.map((item) => item.id === id ? { ...item, deletedAt: at, updatedAt: at } : item) }, true, true);
    this.checkpoint();
  }
  restore(id: string) {
    this.commit({ ...this.doc, entries: this.doc.entries.map((entry) => entry.id === id ? { ...entry, deletedAt: undefined, updatedAt: now() } : entry) }, true, true);
  }
  undo() {
    const command = this.undoStack.pop(); if (!command) return;
    const previous = command.before;
    const after = new Map(command.after.entries.map((entry) => [entry.id, entry]));
    // Preserve edits made after the command, while correctly reversing the
    // command's own body changes (in particular combining several notes).
    const current = this.entries;
    const entries = previous.entries.map((entry) => { const latest = current.get(entry.id); return latest && after.get(entry.id)?.body !== latest.body ? { ...entry, body: latest.body, updatedAt: latest.updatedAt } : entry; });
    const previousIds = new Set(entries.map((entry) => entry.id));
    const retained = this.doc.entries.filter((entry) => !previousIds.has(entry.id) && after.has(entry.id) && entry.body !== after.get(entry.id)!.body && this.plain(entry).trim());
    entries.push(...retained);
    const captures = new Map(previous.captures.map((capture) => [capture.id, capture]));
    for (const entry of retained) for (const id of entry.captureIds) if (!captures.has(id) && this.captures.has(id)) captures.set(id, { ...this.captures.get(id)!, visible: false });
    this.commit({ ...previous, entries: entries.map((entry) => ({ ...entry, body: interruptExchanges(entry.body) })), captures: [...captures.values()] }, true);
  }
  assetDataUrl(id: string) { const asset = this.assetMap.get(id); if (!asset) return; if (!this.assetDataUrls.has(id)) this.assetDataUrls.set(id, dataUrl(asset)); return this.assetDataUrls.get(id); }
  assetUrl(id: string): string | undefined {
    const asset = this.assetMap.get(id); if (!asset) return;
    if (this.assetUrls.has(id)) return this.assetUrls.get(id);
    const bytes = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
    this.assetUrls.set(id, url); return url;
  }
  private releaseUrls() { for (const url of this.assetUrls.values()) URL.revokeObjectURL(url); this.assetUrls.clear(); this.assetDataUrls.clear(); }
  private invalidateAsset(id: string) { const url = this.assetUrls.get(id); if (url) URL.revokeObjectURL(url); this.assetUrls.delete(id); this.assetDataUrls.delete(id); }
  addImageDataUrl(data: string, id: string = crypto.randomUUID()): string {
    const asset = assetFromDataUrl(id, data); if (!asset) throw new Error("Use a PNG, JPEG, GIF, or WebP image.");
    const existing = this.assets.find((item) => item.mediaType === asset.mediaType && item.data === asset.data); if (existing) return existing.id;
    if (this.assetMap.has(id)) { id = crypto.randomUUID(); asset.id = id; }
    this.assets = [...this.assets, asset]; this.assetMap.set(id, asset);
    return id;
  }
  private setMarks<T extends { id: string }>(kind: "pdf" | "native" | "dive", list: T[], previous: T[]) {
    const captures = new Map(this.captures), entries = new Map(this.entries);
    const ids = new Set(list.map((mark) => `${kind}:${mark.id}`));
    for (const mark of previous) { const id = `${kind}:${mark.id}`, capture = captures.get(id); if (!ids.has(id) && capture) captures.set(id, { ...capture, visible: false }); }
    for (const mark of list) {
      if (previous.includes(mark)) continue;
      const id = `${kind}:${mark.id}`;
      const source = migrateNotebook(this.docId, { [kind === "pdf" ? "highlights" : kind === "native" ? "nativeAnnotations" : "diveHighlights"]: [mark] });
      const capture = source.notebook.captures[0], migratedEntry = source.notebook.entries[0];
      if (!capture || !migratedEntry) continue;
      const before = captures.get(id), owner = this.owners.get(id), oldEntry = owner ? entries.get(owner) : entries.get(migratedEntry.id);
      // Preserve rich writing when a change only affects the annotation style.
      let body = oldEntry?.body ?? migratedEntry.body;
      const oldMark = previous.find((item) => item.id === mark.id) as (T & { comment?: string; content?: { text?: string }; type?: string }) | undefined;
      const newMark = mark as T & { comment?: string; content?: { text?: string }; type?: string };
      const newText = kind === "pdf" && newMark.type === "freetext" ? newMark.content?.text : newMark.comment;
      const oldText = kind === "pdf" && oldMark?.type === "freetext" ? oldMark.content?.text : oldMark?.comment;
      if (oldEntry && newText !== oldText && newText !== this.plain(oldEntry)) body = textBody(newText ?? "");
      const entry = oldEntry ? { ...oldEntry, body, deletedAt: undefined, updatedAt: body === oldEntry.body ? oldEntry.updatedAt : now() } : migratedEntry;
      for (const asset of source.assets) {
        const saved = this.assetMap.get(asset.id);
        if (saved?.data === asset.data && saved.mediaType === asset.mediaType) continue;
        this.invalidateAsset(asset.id);
        this.assetMap.set(asset.id, asset); this.assets = [...this.assets.filter((item) => item.id !== asset.id), asset];
      }
      captures.set(id, { ...before, ...capture, imageId: capture.imageId ?? before?.imageId, visible: true });
      entries.set(entry.id, entry);
      if (body !== oldEntry?.body) this.journal.set(entry.id, entry);
    }
    this.commit({ ...this.doc, captures: [...captures.values()], entries: [...entries.values()] }, true, true);
  }
  setPdfHighlights = (action: SetStateAction<CommentedHighlight[]>) => this.setMarks("pdf", changed(action, this.pdf), this.pdf);
  setNativeAnnotations = (action: SetStateAction<DocumentAnnotation[]>) => this.setMarks("native", changed(action, this.native), this.native);
  captureDive(mark: Omit<DiveHighlight, "id" | "createdAt">): string {
    const existing = this.doc.captures.find((capture) => capture.dive?.panelId === mark.panelId && capture.dive.text === mark.text && capture.dive.turnIndex === mark.turnIndex && (capture.dive.occurrence ?? 0) === (mark.occurrence ?? 0));
    if (existing?.dive) {
      const saved = existing.dive;
      const divePanelId = mark.divePanelId ?? saved.divePanelId;
      if (!existing.visible || !this.owners.has(existing.id)) {
        const restored = { ...saved, divePanelId, comment: this.plain(this.entryForCapture(existing.id)) };
        this.setDiveHighlights((previous) => [restored, ...previous.filter((item) => item.id !== saved.id)]);
      } else if (divePanelId !== saved.divePanelId) {
        this.setDiveHighlights((previous) => previous.map((item) => item.id === saved.id ? { ...item, divePanelId } : item));
      }
      return saved.id;
    }
    const id = crypto.randomUUID(); this.setDiveHighlights((previous) => [{ ...mark, id, createdAt: now() }, ...previous]); return id;
  }
  setDiveHighlights = (action: SetStateAction<DiveHighlight[]>) => this.setMarks("dive", changed(action, this.dive), this.dive);
}

export function usePdfMarks(store: NotebookStore) { return useSyncExternalStore(store.subscribeMarks, store.getPdfHighlights); }
export function useNativeMarks(store: NotebookStore) { return useSyncExternalStore(store.subscribeMarks, store.getNativeAnnotations); }
export function useDiveMarks(store: NotebookStore) { return useSyncExternalStore(store.subscribeMarks, store.getDiveHighlights); }
