import type { Attachment } from "../grounding/attachments.ts";
import type { DocumentEngine } from "./engine.ts";
import type { FlowAnchor } from "./model.ts";
import { safeDocumentUrl } from "./model.ts";

// Images are decoded and resized only when explicitly added to a question
// or dived into. The same path handles Markdown links and future bundled
// EPUB/HTML assets. No screenshots, OCR or image analysis during reading.
export async function imageAttachment(engine: DocumentEngine, anchor: FlowAnchor, signal: AbortSignal): Promise<Attachment | null> {
  if (anchor.kind !== "object") return null;
  const object = engine.document.objects.find((object) => object.id === anchor.objectId && object.blockId === anchor.blockId);
  if (object?.kind !== "image" || !object.src) return null;
  let blob = engine.document.assets?.get(object.src);
  if (!blob) {
    const src = safeDocumentUrl(object.src, true);
    if (src?.startsWith("data:image/")) blob = await (await fetch(src, { signal })).blob();
    else if (src && /^https?:/i.test(src)) {
      // The existing asset proxy handles CORS and validates redirects.
      const { serverFetcher } = await import("../web/fetcher.ts");
      const resource = await serverFetcher().fetch(src, { purpose: "asset", signal });
      blob = new Blob([resource.bytes as BlobPart], { type: resource.contentType });
    }
  }
  if (!blob) throw new Error("This image file wasn't included with the document. Select its caption or a nearby passage instead.");
  if (blob.size > 15 * 1024 * 1024) throw new Error("This image is too large to attach.");
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const ratio = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Couldn't prepare this image.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { id: crypto.randomUUID(), kind: "region", text: engine.document.blocks[engine.blockIndex.get(object.blockId)!].text.slice(object.start, object.end) || object.label,
      pageNumber: engine.unitForAnchor(anchor), range: [object.start, object.end], location: anchor, locationLabel: `${object.label} · ${engine.labelForUnit(engine.unitForAnchor(anchor))}`,
      image: { mediaType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] } };
  } finally { URL.revokeObjectURL(url); }
}
