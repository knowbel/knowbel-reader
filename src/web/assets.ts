import { sniffImageType } from "../epub/paths.ts";
import type { ImportReport, WebFetcher } from "./types.ts";

// Downloads every picture in the article into the book's files, and points
// the article at them. A picture that can't be had (gone, blocked, not a
// picture after all) is replaced by a visible note with its address — and
// listed in the report — rather than silently left out.

const CONCURRENCY = 6;
// Pictures beyond this are redrawn smaller: more than a page of the book
// needs, zoomed in, and they'd bloat the PDF.
const MAX_SIDE = 2400;
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

type Kind = ReturnType<typeof sniffImageType> | "avif" | "bmp" | "ico";

function kindOf(bytes: Uint8Array, contentType: string): Kind | null {
  const sniffed = sniffImageType(bytes);
  if (sniffed !== "other") return sniffed;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 32));
  if (head.slice(4, 12) === "ftypavif" || head.slice(4, 12) === "ftypavis") return "avif";
  if (head.startsWith("BM")) return "bmp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  if (/^image\/(avif|bmp|x-icon|vnd\.microsoft\.icon)/i.test(contentType)) return "other";
  return null; // an HTML error page, or something else that isn't a picture
}

function decodeDataUrl(url: string): { bytes: Uint8Array; contentType: string } | null {
  const match = url.match(/^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/is);
  if (!match) return null;
  try {
    if (match[3]) {
      const binary = atob(match[4].replace(/\s+/g, ""));
      return { bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)), contentType: match[1] };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(match[4])), contentType: match[1] };
  } catch {
    return null;
  }
}

// A very large picture, redrawn at most MAX_SIDE pixels on its long side.
async function shrink(bytes: Uint8Array, kind: Kind): Promise<{ bytes: Uint8Array; kind: Kind }> {
  if (bytes.byteLength < SHRINK_ABOVE_BYTES || kind === "svg" || kind === "gif") return { bytes, kind };
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) {
      bitmap.close();
      return { bytes, kind };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const asPng = kind === "png";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, asPng ? "image/png" : "image/jpeg", 0.9));
    if (!blob) return { bytes, kind };
    return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: asPng ? "png" : "jpeg" };
  } catch {
    return { bytes, kind };
  }
}

const EXTENSIONS: Record<string, string> = { jpeg: "jpg", png: "png", gif: "gif", webp: "webp", svg: "svg", avif: "avif", bmp: "bmp", ico: "ico", other: "img" };

// Native sources embed raster images so they reopen without the network.
// SVG is decoded as an image, never inserted into the application's DOM.
export async function rasterizeImage(bytes: Uint8Array, contentType: string): Promise<Uint8Array | null> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  try {
    const image = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      const finish = (ok: boolean) => { clearTimeout(timer); image.onload = null; image.onerror = null; resolve(ok); };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
    if (!loaded || !image.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
  finally { URL.revokeObjectURL(url); }
}

export async function saveImages(
  content: HTMLElement,
  options: {
    fetcher: WebFetcher;
    pageUrl: string;
    files: Map<string, Uint8Array>;
    report: ImportReport;
    signal?: AbortSignal;
    native?: boolean;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<void> {
  const { fetcher, pageUrl, files, report, signal } = options;
  const doc = content.ownerDocument;
  const byUrl = new Map<string, HTMLImageElement[]>();
  for (const img of content.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (files.has(src) || (!options.native && !/^(https?:|data:)/i.test(src))) continue;
    byUrl.set(src, [...(byUrl.get(src) ?? []), img]);
  }
  const urls = [...byUrl.keys()];
  let done = 0;
  let next = 0;
  const indices = new Map(urls.map((url, index) => [url, index + 1]));
  options.onProgress?.(0, urls.length);

  const normalize = async (bytes: Uint8Array, kind: Kind, contentType: string): Promise<{ bytes: Uint8Array; kind: Kind } | null> => {
    if (options.native && !["png", "jpeg", "gif", "webp"].includes(kind)) {
      const png = await rasterizeImage(bytes, contentType);
      return png ? { bytes: png, kind: "png" } : null;
    }
    return shrink(bytes, kind);
  };
  const fetchOne = async (url: string): Promise<{ bytes: Uint8Array; kind: Kind } | null> => {
    if (/^data:/i.test(url)) {
      const decoded = decodeDataUrl(url);
      if (!decoded) return null;
      const kind = kindOf(decoded.bytes, decoded.contentType);
      return kind ? normalize(decoded.bytes, kind, decoded.contentType) : null;
    }
    if (!/^https?:/i.test(url)) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resource = await fetcher.fetch(url, { purpose: "asset", referer: pageUrl, signal });
        const kind = kindOf(resource.bytes, resource.contentType);
        return kind ? normalize(resource.bytes, kind, kind === "svg" ? "image/svg+xml" : resource.contentType) : null;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return null;
  };

  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const saved = await fetchOne(url);
      const images = byUrl.get(url)!;
      if (saved) {
        const path = `images/${String(indices.get(url)).padStart(3, "0")}.${EXTENSIONS[saved.kind] ?? "img"}`;
        files.set(path, saved.bytes);
        for (const img of images) img.setAttribute("src", path);
        report.imagesSaved += 1;
      } else {
        const thumbnails = images.map((img) => img.closest("[data-kr-media]") !== null);
        images.forEach((img, i) => {
          if (thumbnails[i]) {
            img.remove(); // a video's thumbnail: the card's link is what matters
            return;
          }
          const alt = (img.getAttribute("alt") ?? "").trim();
          const note = doc.createElement("span");
          note.setAttribute("data-kr-missing", "");
          note.append(`Picture not saved${alt ? ` (${alt})` : ""} — `);
          const link = doc.createElement("a");
          link.setAttribute("href", /^https?:/i.test(url) ? url : pageUrl);
          link.textContent = "view it on the web";
          note.append(link);
          img.replaceWith(note);
        });
        if (thumbnails.some((thumbnail) => !thumbnail)) {
          report.imagesFailed.push({ url: /^https?:/i.test(url) ? url : pageUrl, alt: (images[0].getAttribute("alt") ?? "").trim() });
        }
      }
      done += 1;
      options.onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
}
