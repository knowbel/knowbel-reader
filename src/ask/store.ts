import { useSyncExternalStore } from "react";
import type { AskThread } from "./types";

// Ask threads live outside React, in a subscribable store, so an answer
// keeps streaming in when the reader switches sidebar panels mid-answer —
// the job writes here whether or not the panel is mounted. (Same pattern as
// the glossary's store.)
export class AskStore {
  private threads: AskThread[] = [];
  private persist: ((threads: AskThread[]) => void) | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.threads;

  // `persist` saves the threads of the document just loaded.
  load(loaded: AskThread[], persist: (threads: AskThread[]) => void) {
    this.persist = persist;
    const needsSave = loaded.some((thread) => thread.turns.some((turn) => !turn.id || turn.status === "streaming"));
    // An answer still streaming when the app closed can't resume.
    this.threads = loaded.map((thread) => ({
      ...thread,
      turns: thread.turns.map((saved) => {
        const turn = saved.id ? saved : { ...saved, id: crypto.randomUUID() };
        return (
        turn.status === "streaming"
          ? { ...turn, status: "error" as const, content: turn.content || "⚠️ Interrupted before it finished." }
          : turn);
      }),
    }));
    this.emit();
    if (needsSave) this.persist(this.threads);
  }

  get(id: string): AskThread | undefined {
    return this.threads.find((thread) => thread.id === id);
  }

  add(thread: AskThread) {
    this.threads = [thread, ...this.threads];
    this.commit();
  }

  // `persist: false` for the many small updates while an answer streams in —
  // the job persists once when it settles.
  update(id: string, change: (thread: AskThread) => AskThread, { persist = true } = {}) {
    this.threads = this.threads.map((thread) => { if (thread.id !== id) return thread; const next = change(thread); return { ...next, turns: next.turns.map((turn) => turn.id ? turn : { ...turn, id: crypto.randomUUID() }) }; });
    if (persist) this.commit();
    else this.emit();
  }

  remove(id: string) {
    this.threads = this.threads.filter((thread) => thread.id !== id);
    this.commit();
  }

  private commit() {
    this.persist?.(this.threads);
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export function useAskThreads(store: AskStore): AskThread[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
