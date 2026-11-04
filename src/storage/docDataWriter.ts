import type { DocDataKind, LibraryStorage } from "./types.ts";

const DEBOUNCE_MS = 300;

interface Pending {
  docId: string;
  kind: DocDataKind;
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
}

// Coalesces the app's frequent state changes into one write per document
// and kind: typing a comment or streaming a dive reply changes state many
// times a second, and each change would otherwise rewrite the whole file.
// Unchanged values (by reference) are never written — so re-saving what was
// just loaded costs nothing.
export class DocDataWriter {
  private pending = new Map<string, Pending>();
  private last = new Map<string, unknown>();
  private inFlight = new Set<Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  private storage: LibraryStorage;
  private onError: (error: unknown) => void;

  constructor(storage: LibraryStorage, onError: (error: unknown) => void = console.error) {
    this.storage = storage;
    this.onError = onError;
  }

  // Records a value as already stored (e.g. just loaded), so scheduling that
  // same value doesn't write it back.
  prime(docId: string, kind: DocDataKind, value: unknown) {
    this.last.set(`${docId}/${kind}`, value);
  }

  schedule(docId: string, kind: DocDataKind, value: unknown) {
    const key = `${docId}/${kind}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    else if (this.last.get(key) === value) return;
    const timer = setTimeout(() => void this.write(key), DEBOUNCE_MS);
    this.pending.set(key, { docId, kind, value, timer });
  }

  // Writes everything scheduled now — before switching documents, and when
  // the page is going away.
  async flush(): Promise<void> {
    await Promise.all(
      [...this.pending.entries()].map(([key, { timer }]) => {
        clearTimeout(timer);
        return this.write(key);
      }),
    );
    // A timer may already have started a write before flush was called.
    // Leaving a reader must wait for that write as well as pending timers.
    await Promise.all([...this.inFlight]);
  }

  private write(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();
    this.pending.delete(key);
    this.last.set(key, entry.value);
    // Keep the same ordering on IndexedDB/memory as on desktop, even when
    // a second edit arrives while the previous save is still in flight.
    const previous = this.writes.get(key) ?? Promise.resolve();
    const write = previous.then(() => this.storage.putData(entry.docId, entry.kind, entry.value)).catch((error) => {
      if (this.last.get(key) === entry.value) this.last.delete(key);
      this.onError(error);
    });
    this.writes.set(key, write);
    this.inFlight.add(write);
    void write.finally(() => {
      this.inFlight.delete(write);
      if (this.writes.get(key) === write) this.writes.delete(key);
    });
    return write;
  }
}
