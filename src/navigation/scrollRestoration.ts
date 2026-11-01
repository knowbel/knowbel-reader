const CORRECTION_DELAYS_MS = [500, 1200, 2200, 3500, 5000, 7000];

// Keep correcting while pdf.js measures pages, but yield permanently to
// user input. Listen on the stable pane wrapper because its scrollable PDF
// child may not exist yet. Scroll events themselves also come from pdf.js
// and must not cancel restoration.
export function retryScrollRestoration(container: HTMLElement, correct: () => void): () => void {
  let stopped = false;
  const timeouts = CORRECTION_DELAYS_MS.map((delay) => setTimeout(() => {
    if (stopped) return;
    try {
      correct();
    } catch {
      // The viewer may still be loading; a later correction can retry.
    }
  }, delay));

  const doc = container.ownerDocument;
  const stop = () => {
    stopped = true;
    timeouts.forEach(clearTimeout);
    container.removeEventListener("wheel", stop, true);
    container.removeEventListener("touchstart", stop, true);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  container.addEventListener("wheel", stop, { capture: true, passive: true });
  container.addEventListener("touchstart", stop, { capture: true, passive: true });
  // Navigation controls and keyboard shortcuts can live outside the pane.
  doc.addEventListener("pointerdown", stop, { capture: true, passive: true });
  doc.addEventListener("keydown", stop, true);
  return stop;
}
