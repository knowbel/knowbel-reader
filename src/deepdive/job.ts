// Stop waiting for preparation immediately, even if PDF indexing itself
// cannot be cancelled. Late preparation results have no effect on the job.
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Stopped", "AbortError");
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Stopped", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
