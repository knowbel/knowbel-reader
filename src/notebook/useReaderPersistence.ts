import { useEffect, useRef } from "react";
import { showNotice } from "../components/notices";
import { registerReaderTransition } from "./readerTransition";

// Browser lifecycle checkpoints supplement normal saves. A native close can
// actually wait for storage, so do so before allowing the window to close.
export function useReaderPersistence(options: { flush: () => Promise<unknown>; checkpoint: () => void; cancel: () => void; beforeLeave?: () => Promise<unknown> }) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    const unregister = registerReaderTransition(async () => {
      latest.current.cancel(); latest.current.checkpoint();
      await latest.current.beforeLeave?.();
      await latest.current.flush();
    });
    const checkpoint = () => { latest.current.checkpoint(); void latest.current.flush().catch(() => {}); };
    const hidden = () => { if (document.visibilityState === "hidden") checkpoint(); };
    const pageHide = () => { latest.current.cancel(); checkpoint(); };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pageHide);
    let disposed = false, allowClose = false;
    let unlisten: (() => void) | undefined;
    if ("__TAURI_INTERNALS__" in window) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      const remove = await current.onCloseRequested((event) => {
        if (allowClose) return;
        event.preventDefault(); latest.current.cancel(); latest.current.checkpoint();
        void latest.current.flush().then(() => { allowClose = true; return current.close(); }).catch(() => showNotice("Your latest changes couldn’t be saved. Keep the document open and retry."));
      });
      if (disposed) remove(); else unlisten = remove;
    }).catch(() => {});
    return () => { disposed = true; unregister(); unlisten?.(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pageHide); latest.current.checkpoint(); };
  }, []);
}
