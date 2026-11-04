import { lazy, Suspense, useEffect, useState } from "react";
import LibraryHome from "./library/LibraryHome";
import { getStorage } from "./storage";
import type { DocumentMeta } from "./storage/types";
import ReaderBoundary from "./components/ReaderBoundary";
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
