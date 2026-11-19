import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { browserAction, loadPageArchive, openImportBrowser, positionPage, type PageBounds } from "./browser";
import "./page.css";

// `source: "saved"` replays the stored web archive (see loadArchive) in the
// same restricted view, without contacting the site.
export default function EmbeddedPage({ url, owner, onReady, onLoading, retainOnUnmount, initialScroll, source = "live", loadArchive }: {
  url: string; owner: string; onReady?: (url?: string) => void; onLoading?: () => void; retainOnUnmount?: () => boolean; initialScroll?: number;
  source?: "live" | "saved"; loadArchive?: () => Promise<Uint8Array | null>;
}) {
  const slot = useRef<HTMLDivElement>(null), callbacks = useRef({ onReady, onLoading, retainOnUnmount, loadArchive });
  callbacks.current = { onReady, onLoading, retainOnUnmount, loadArchive };
  const [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false, created = false, frame = 0, previous = "", restored = false;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = (loaded?: string) => {
      if (!restored && initialScroll !== undefined && Number.isFinite(initialScroll)) {
        restored = true; restoreTimer = setTimeout(() => { if (!disposed) void browserAction(owner, "scroll", String(initialScroll)).catch(() => {}); }, 300);
      }
      callbacks.current.onReady?.(loaded);
    };
    let removeListener: (() => void) | undefined;
    const bounds = (): { bounds: PageBounds; visible: boolean } => {
      const root = slot.current!, rect = root.getBoundingClientRect();
      const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
      const width = Math.max(1, Math.min(innerWidth, rect.right) - x), height = Math.max(1, Math.min(innerHeight, rect.bottom) - y);
      // Native child views sit above HTML. Yield to reader menus/dialogs so
      // they remain clickable, and hide when the source pane is offscreen.
      const covered = [...document.querySelectorAll('.rail-popover,.dive-selection-tip,[aria-modal="true"]')].some((element) => !element.contains(root));
      return { bounds: { x, y, width, height }, visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && !covered && !document.hidden };
    };
    const position = () => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (disposed || !created) return;
        const next = bounds(), key = JSON.stringify(next); if (key === previous) return; previous = key;
        void positionPage(owner, next.bounds, next.visible).catch(() => {});
      });
    };
    const observer = new ResizeObserver(position);
    const changes = new MutationObserver(position);
    if (slot.current) observer.observe(slot.current);
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-modal"] });
    window.addEventListener("resize", position); document.addEventListener("visibilitychange", position);
    // A portal may reparent the source pane without mounting it again.
    document.addEventListener("scroll", position, true);
    void (async () => {
      try {
        removeListener = await listen<{ owner: string; phase: string; url: string }>("knowbel-page-load", ({ payload }) => {
          if (disposed || payload.owner !== owner) return;
          if (payload.phase === "ready") ready(payload.url); else callbacks.current.onLoading?.();
        });
        if (disposed) { removeListener(); return; }
        const saved = source === "saved" ? await callbacks.current.loadArchive?.() : null;
        if (disposed) { removeListener(); return; }
        if (source === "saved" && !saved) throw new Error("This page hasn't been saved for offline reading yet.");
        const reused = await openImportBrowser(url, owner, bounds().bounds, !!saved);
        created = true;
        if (saved) await loadPageArchive(owner, url, saved);
        if (!disposed) { setError(""); position(); if (reused) ready(); }
      } catch (error) { if (!disposed) setError(String(error)); }
    })();
    return () => {
      disposed = true; observer.disconnect(); changes.disconnect(); removeListener?.(); cancelAnimationFrame(frame); clearTimeout(restoreTimer);
      window.removeEventListener("resize", position); document.removeEventListener("visibilitychange", position); document.removeEventListener("scroll", position, true);
      // Ownership makes StrictMode cleanup and document handoffs harmless:
      // an old pane cannot close a newer document's child view.
      if (callbacks.current.retainOnUnmount?.()) setTimeout(() => { void browserAction(owner, "close").catch(() => {}); }, 10000);
      else void browserAction(owner, "close").catch(() => {});
    };
  }, [url, owner, retry, initialScroll, source]);
  return <div ref={slot} className="embedded-document-page" aria-label="Original web page">
    {error ? <div className="embedded-page-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry page</button></div> : <span className="embedded-page-placeholder">Loading original page…</span>}
  </div>;
}
