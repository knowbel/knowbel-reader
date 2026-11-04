import type { DocumentFormat, FlowDocument } from "./model.ts";

export interface DocumentAdapter {
  format: DocumentFormat;
  parse(input: { id: string; bytes: Uint8Array; fileName: string }): FlowDocument | Promise<FlowDocument>;
}

interface AdapterRegistration {
  format: DocumentFormat;
  extensions: string[];
  mimeTypes: string[];
  load: () => Promise<DocumentAdapter>;
  parseLarge?: DocumentAdapter["parse"];
}

// Each format is a lazy parser producing the same inert tree. No format
// plugin needs to implement annotations, tooltips, glossary or AI jobs.
const adapters = new Map<DocumentFormat, AdapterRegistration>();

export function registerDocumentAdapter(registration: AdapterRegistration) {
  adapters.set(registration.format, registration);
}

registerDocumentAdapter({ format: "markdown", extensions: [".md", ".markdown"], mimeTypes: ["text/markdown", "text/x-markdown"],
  load: () => import("../markdown/adapter.ts").then((module) => module.markdownAdapter),
  parseLarge: async (input) => {
    const { parseInWorker, WorkerUnavailableError } = await import("../markdown/workerClient.ts");
    try { return await parseInWorker(input); }
    catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      // Some packaged webviews cannot start workers on their asset scheme.
      // Preserve native reading there, using the identical parser locally.
      return (await import("../markdown/adapter.ts")).markdownAdapter.parse(input);
    }
  },
});

// One bounded cache shares import/open and StrictMode's overlapping loads.
// The active reader releases it on close; no library-wide document cache.
let recent: { key: string; promise: Promise<FlowDocument> } | undefined;

export async function parseDocument(format: DocumentFormat, input: Parameters<DocumentAdapter["parse"]>[0]) {
  const adapter = adapters.get(format);
  if (!adapter) throw new Error(`Native ${format} reading is not available yet.`);
  const key = `${format}/${input.id}`;
  if (recent?.key === key) return recent.promise;
  const promise = Promise.resolve().then(async () => {
    if (input.bytes.byteLength >= 256 * 1024 && typeof Worker !== "undefined" && adapter.parseLarge) return adapter.parseLarge(input);
    return (await adapter.load()).parse(input);
  });
  recent = { key, promise };
  void promise.catch(() => { if (recent?.promise === promise) recent = undefined; });
  return promise;
}

export function releaseDocument(id: string) {
  if (recent?.key.endsWith(`/${id}`)) recent = undefined;
}

export function nativeDocumentFormat(file: { name: string; type?: string }): DocumentFormat | null {
  const name = file.name.toLowerCase();
  const type = file.type?.split(";")[0].toLowerCase().trim();
  for (const adapter of adapters.values()) if (adapter.extensions.some((extension) => name.endsWith(extension)) || (type && adapter.mimeTypes.includes(type))) return adapter.format;
  return null;
}

export const DOCUMENT_FILE_ACCEPT = ["application/pdf", ".pdf", "application/epub+zip", ".epub",
  ...[...adapters.values()].flatMap((adapter) => [...adapter.mimeTypes, ...adapter.extensions])].join(",");
export function isMarkdown(file: { name: string; type?: string }) {
  return nativeDocumentFormat(file) === "markdown";
}
