import type { DocDataKind, LibraryStorage } from "./types.ts";

const DEBOUNCE_MS = 300;
interface Pending {
  docId: string;
  kind: DocDataKind;
  value: unknown;
  timer?: ReturnType<typeof setTimeout>;
}

// Only acknowledged values count as saved. Failed writes stay dirty, and
// controlled navigation can await flush(), retry, or keep the reader open.
export class DocDataWriter {
  private pending = new Map<string, Pending>();
  private last = new Map<string, unknown>();
  private inFlight = new Set<Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  private scheduled = new Map<string, unknown>();
  private storage: LibraryStorage;
  private onError: (error: unknown) => void;

  constructor(storage: LibraryStorage, onError: (error: unknown) => void = console.error) {
    this.storage = storage;
    this.onError = onError;
  }
  prime(docId: string, kind: DocDataKind, value: unknown) { this.last.set(`${docId}/${kind}`, value); }
  schedule(docId: string, kind: DocDataKind, value: unknown) {
    const key = `${docId}/${kind}`;
    const previous = this.pending.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    if (!previous && (this.scheduled.get(key) === value || this.last.get(key) === value)) return;
    const timer = setTimeout(() => void this.write(key).catch(() => {}), DEBOUNCE_MS);
    this.pending.set(key, { docId, kind, value, timer });
  }
  async flush(): Promise<void> {
    const pending = [...this.pending];
    const running = [...this.inFlight];
    await Promise.all([...pending.map(([key, entry]) => { clearTimeout(entry.timer); return this.write(key); }), ...running]);
  }
  private write(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.scheduled.set(key, entry.value);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await this.storage.putData(entry.docId, entry.kind, entry.value);
      this.last.set(key, entry.value);
    }).catch((error) => {
      // Never replace a newer edit with an older failed value.
      if (!this.pending.has(key) && this.scheduled.get(key) === entry.value) this.pending.set(key, { ...entry, timer: undefined });
      this.onError(error);
      throw error;
    });
    this.writes.set(key, write);
    this.inFlight.add(write);
    const cleanup = () => {
      this.inFlight.delete(write);
      if (this.writes.get(key) === write) { this.writes.delete(key); this.scheduled.delete(key); }
    };
    void write.then(cleanup, cleanup);
    return write;
  }
}
