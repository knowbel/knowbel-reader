import { lazy, Suspense, useEffect, useRef, useState } from "react";
import LibraryHome from "./library/LibraryHome";
import { getStorage } from "./storage";
import { importFiles } from "./library/importFiles";
import type { DocumentMeta } from "./storage/types";
import ReaderBoundary from "./components/ReaderBoundary";
import { showNotice } from "./components/notices";
import { prepareReaderTransition } from "./notebook/readerTransition";
import "./App.css";

// A native text document never loads the PDF viewer, worker, fonts or
// conversion pipeline. Each reader owns its session and flushes on exit.
const PdfReader = lazy(async () => {
  // pdf_viewer reads globalThis.pdfjsLib while its module evaluates. With
  // separate lazy chunks, WebKit can evaluate the viewer before the core
  // on a cold library reopen (a fresh import already loaded the core to
  // read metadata). Establish the core explicitly before loading the reader.
  await import("pdfjs-dist");
  return import("./PdfReader");
});
const NativeReader = lazy(() => import("./document/NativeReader"));

export default function App() {
  const [selectedDocument, setDocument] = useState<DocumentMeta | null>(null);
  const selectedRef = useRef(selectedDocument); selectedRef.current = selectedDocument;
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !navigator.userAgent.includes("Mac")) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event"), import("./library/openedFiles")])
      .then(([{ invoke }, { listen }, { watchOpenedFiles }]) => {
        if (disposed) return;
        stop = watchOpenedFiles({
          listen: (wake) => listen("knowbel-opened-files", wake),
          pending: () => invoke("pending_opened_files"),
          read: (id) => invoke<ArrayBuffer>("read_opened_file", { id }),
        }, async (file) => {
          const result = await importFiles(getStorage(), [file]);
          const meta = result.added[0] ?? result.alreadyThere[0];
          if (!meta) throw new Error("The file is unsupported, unreadable, or damaged.");
          if (meta.docId === selectedRef.current?.docId) return;
          try { await prepareReaderTransition(); }
          catch { throw new Error("Your current changes couldn’t be saved. Keep this document open and try again."); }
          setDocument(meta);
        }, showNotice);
      }).catch(() => showNotice("Couldn’t set up opening documents from macOS."));
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => {
    const title = selectedDocument ? `${selectedDocument.title} — Knowbel Reader` : "Knowbel Reader";
    document.title = title;
    if ("__TAURI_INTERNALS__" in window) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
  }, [selectedDocument]);
  if (!selectedDocument) return <LibraryHome storage={getStorage()} onOpen={setDocument} />;
  const Reader = selectedDocument.format && selectedDocument.format !== "pdf" ? NativeReader : PdfReader;
  return <ReaderBoundary key={selectedDocument.docId} title={selectedDocument.title} onHome={() => setDocument(null)}>
    <Suspense fallback={<div className="reader-loading" role="status">Opening {selectedDocument.title}…</div>}>
      <Reader initialDocument={selectedDocument} onHome={() => setDocument(null)} onOpenDocument={setDocument} />
    </Suspense>
  </ReaderBoundary>;
}
