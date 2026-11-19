import { safeDocumentUrl } from "./model.ts";

export function mediaUrl(value: string): string | null {
  const safe = safeDocumentUrl(value);
  if (!safe || !/^https?:/i.test(safe)) return null;
  try { const url = new URL(safe); return url.username || url.password ? null : url.href; }
  catch { return null; }
}

// Only these providers become frames. Other embeds remain ordinary links.
export function playerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!mediaUrl(url.href)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["youtube.com", "youtube-nocookie.com", "m.youtube.com", "youtu.be"].includes(host)) {
      const id = host === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
      return id && /^[\w-]{6,}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const id = url.pathname.match(/^\/(?:video\/)?(\d+)(?:\/|$)/)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch { /* Not a supported provider. */ }
  return null;
}
