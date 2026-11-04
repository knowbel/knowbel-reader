import { isEpub, pdfForEpub } from "../epub/index.ts";
import { nativeDocumentFormat, parseDocument } from "../document/registry.ts";
import { computeDocId, importDocument } from "../storage/documents.ts";
import type { DocumentMeta, LibraryStorage } from "../storage/types.ts";
import { pickTitle } from "./library.ts";

export interface ImportResult {
  added: DocumentMeta[];
  alreadyThere: DocumentMeta[];
  failed: string[]; // unsupported or unreadable file names
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Adds documents one at a time. Native formats retain their source bytes;
// PDFs provide metadata/cover and EPUBs currently convert to PDF.
// A document already there — the same content, under any name — isn't added
// twice.
export async function importFiles(
  storage: LibraryStorage,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { added: [], alreadyThere: [], failed: [] };
  const readable = files.filter((file) => isPdf(file) || isEpub(file) || nativeDocumentFormat(file));
  result.failed.push(...files.filter((file) => !readable.includes(file)).map((file) => file.name));
  for (const [index, file] of readable.entries()) {
    onProgress?.(index, readable.length);
    try {
      let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let docId: string | undefined;
      const nativeFormat = nativeDocumentFormat(file);
      if (nativeFormat) {
        docId = await computeDocId(bytes);
        const existing = await storage.getMeta(docId);
        if (existing && !existing.fileMissing) {
          result.alreadyThere.push(existing);
          continue;
        }
        const document = await parseDocument(nativeFormat, { id: docId, bytes, fileName: file.name });
        const imported = await importDocument(storage, { bytes, fileName: file.name, docId, format: nativeFormat });
        const complete = { ...imported.meta, title: existing?.title ?? document.title };
        await storage.putMeta(complete);
        result.added.push(complete);
        continue;
      }
      if (isEpub(file)) {
        const epub = await pdfForEpub(storage, bytes);
        if (epub.existing) {
          result.alreadyThere.push(epub.existing);
          continue;
        }
        ({ docId, pdf: bytes } = epub);
      }
      const { readPdfInfo } = await import("./pdfInfo.ts");
      const info = await readPdfInfo(bytes);
      if (!info) {
        result.failed.push(file.name);
        continue;
      }
      const { meta, added } = await importDocument(storage, { bytes, fileName: file.name, docId });
      if (!added) {
        result.alreadyThere.push(meta);
        continue;
      }
      const complete: DocumentMeta = {
        ...meta,
        title: pickTitle(info.title, meta.title),
        pageCount: info.pageCount,
        ...(info.author ? { author: info.author } : {}),
      };
      await storage.putMeta(complete);
      if (info.thumbnail) await storage.putData(meta.docId, "thumbnail", info.thumbnail);
      result.added.push(complete);
    } catch (error) {
      console.error(error);
      result.failed.push(file.name);
    }
  }
  onProgress?.(readable.length, readable.length);
  return result;
}
