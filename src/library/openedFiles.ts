export interface OpenedFile { id: number; name: string }
export interface OpenedFilesBridge {
  listen: (wake: () => void) => Promise<() => void>;
  pending: () => Promise<OpenedFile[]>;
  read: (id: number) => Promise<ArrayBuffer>;
}

// Serialize across subscriptions too: React StrictMode may replace a listener
// while an earlier read/import is still in flight.
let work = Promise.resolve();

export function watchOpenedFiles(
  bridge: OpenedFilesBridge,
  open: (file: File) => Promise<void>,
  report: (message: string) => void,
): () => void {
  let stopped = false, requested = false, scheduled = false;
  let unlisten: (() => void) | undefined;
  const schedule = () => {
    requested = true;
    if (scheduled || stopped) return;
    scheduled = true;
    work = work.then(async () => {
      while (requested && !stopped) {
        requested = false;
        for (const file of await bridge.pending()) {
          if (stopped) break;
          try {
            const bytes = await bridge.read(file.id);
            // Finish a consumed request even if the subscription was replaced.
            await open(new File([bytes], file.name));
          } catch (error) {
            report(`Couldn’t open “${file.name}”. ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }).catch(() => report("Couldn’t receive documents from macOS. Try opening the file again."))
      .finally(() => { scheduled = false; if (requested && !stopped) schedule(); });
  };
  // Install the listener before checking the startup queue, closing the gap
  // between cold-launch delivery and later Finder events.
  void bridge.listen(schedule).then((remove) => {
    if (stopped) remove();
    else { unlisten = remove; schedule(); }
  }).catch(() => { if (!stopped) report("Couldn’t listen for documents from macOS."); });
  return () => { stopped = true; unlisten?.(); };
}
