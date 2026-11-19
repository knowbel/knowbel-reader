import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { LibraryStorage } from "../storage/types.ts";
import type { Attachment } from "../grounding/attachments.ts";
import { DocDataWriter } from "../storage/docDataWriter.ts";

export interface ReaderDraft { id: string; text: string; attachments?: Attachment[]; updatedAt: string }
const EMPTY_ATTACHMENTS: Attachment[] = [];
export class ReaderDraftStore {
  private drafts = new Map<string, ReaderDraft>();
  private listeners = new Set<() => void>();
  private writer: DocDataWriter;
  private revision = 0;
  private savedRevision = 0;
  private onDirty: () => void;
  readonly docId: string;
  constructor(storage: LibraryStorage, docId: string, loaded: unknown, onDirty: () => void = () => {}) {
    this.docId = docId; this.onDirty = onDirty;
    this.writer = new DocDataWriter(storage, () => {});
    for (const draft of Array.isArray(loaded) ? loaded as ReaderDraft[] : []) if (typeof draft.id === "string" && typeof draft.text === "string") this.drafts.set(draft.id, draft);
    let recoveredAny = false;
    try {
      const recovered = JSON.parse(localStorage.getItem(this.key()) ?? "[]") as ReaderDraft[];
      for (const draft of recovered) if (typeof draft.id === "string" && typeof draft.text === "string" && (!this.drafts.has(draft.id) || this.drafts.get(draft.id)!.updatedAt < draft.updatedAt)) { this.drafts.set(draft.id, draft); recoveredAny = true; }
    } catch { /* recovery supplements durable storage */ }
    if (recoveredAny) { this.revision++; this.writer.schedule(docId, "readerDrafts", [...this.drafts.values()]); }
  }
  private key() { return `knowbel-drafts:${this.docId}`; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  get = (id: string) => this.drafts.get(id)?.text ?? "";
  getRevision = () => this.revision;
  getAttachments = (id: string): Attachment[] => this.drafts.get(id)?.attachments ?? EMPTY_ATTACHMENTS;
  attachmentMap(prefix: string): Record<string, Attachment[]> { return Object.fromEntries([...this.drafts.values()].filter((draft) => draft.id.startsWith(prefix) && draft.attachments?.length).map((draft) => [draft.id.slice(prefix.length), draft.attachments!])); }
  private update(id: string, patch: Partial<ReaderDraft>) {
    this.drafts.set(id, { id, text: "", ...this.drafts.get(id), ...patch, updatedAt: new Date().toISOString() });
    this.revision++;
    const value = [...this.drafts.values()];
    try { localStorage.setItem(this.key(), JSON.stringify(value)); } catch { /* flush reports durable storage failures */ }
    this.writer.schedule(this.docId, "readerDrafts", value);
    this.onDirty(); this.listeners.forEach((fn) => fn());
  }
  set(id: string, text: string) { if (this.get(id) !== text) this.update(id, { text }); }
  setAttachments(id: string, attachments: Attachment[]) { if (this.getAttachments(id) !== attachments) this.update(id, { attachments }); }
  isDirty() { return this.savedRevision !== this.revision; }
  flush = async (): Promise<void> => {
    const revision = this.revision;
    await this.writer.flush(); this.savedRevision = revision;
    if (this.revision !== revision) await this.flush();
  };
}
export function useReaderDraft(store: ReaderDraftStore | undefined, id: string): [string, (text: string) => void] {
  const subscribe = useCallback((fn: () => void) => store ? store.subscribe(fn) : () => {}, [store]);
  const get = useCallback(() => store?.get(id) ?? "", [store, id]);
  const text = useSyncExternalStore(subscribe, get);
  return [text, useCallback((value: string) => store?.set(id, value), [store, id])];
}
export function useDraftAttachments(store: ReaderDraftStore | undefined, id: string): [Attachment[], (value: SetStateAction<Attachment[]>) => void] {
  const subscribe = useCallback((fn: () => void) => store ? store.subscribe(fn) : () => {}, [store]);
  const get = useCallback(() => store?.getAttachments(id) ?? EMPTY_ATTACHMENTS, [store, id]);
  const attachments = useSyncExternalStore(subscribe, get);
  const set = useCallback((value: SetStateAction<Attachment[]>) => { const previous = store?.getAttachments(id) ?? EMPTY_ATTACHMENTS; store?.setAttachments(id, typeof value === "function" ? value(previous) : value); }, [store, id]);
  return [attachments, set];
}
