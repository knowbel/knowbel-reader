import type { SourceRef } from "../grounding/types.ts";

// Reserve labels even when a passage is absent from a later request.
export function labelWithRegistry(sources: SourceRef[], registry: SourceRef[]): { sources: SourceRef[]; registry: SourceRef[] } {
  const key = (s: SourceRef) => s.chunkId ? `chunk:${s.chunkId}` : `${s.pageNumber}:${s.start}:${s.end}:${s.text}`;
  const next = [...registry];
  const byKey = new Map(next.map((s) => [key(s), s.label]));
  let number = next.reduce((max, s) => Math.max(max, Number(/^S(\d+)$/i.exec(s.label)?.[1] ?? 0)), 0);
  const labeled = sources.map((source) => {
    let label = byKey.get(key(source));
    if (!label) {
      label = `S${++number}`;
      byKey.set(key(source), label);
      next.push({ ...source, label });
    }
    return { ...source, label };
  });
  return { sources: labeled, registry: next };
}
