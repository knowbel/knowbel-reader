import { API_BASE } from "../deepdive/api.ts";
import { WebImportError, type WebFetcher } from "./types.ts";

// The app's way of getting things off the web: through its own server
// (server/web.js), which fetches on the reader's behalf.

function endpoint(params: Record<string, string>): string {
  const path = `${API_BASE}/api/web/fetch?${new URLSearchParams(params)}`;
  // Absolute, so it also works from inside a frame's srcdoc document.
  return new URL(path, window.location.href).href;
}

export function serverFetcher(): WebFetcher {
  return {
    async fetch(url, { purpose, referer, signal }) {
      let response: Response;
      try {
        response = await fetch(endpoint({ url, purpose, ...(referer ? { referer } : {}) }), { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = new WebImportError("Couldn't reach Knowbel's server to fetch the page.");
        failure.browserRecommended = purpose === "page";
        throw failure;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string; upstreamStatus?: number };
        const error = new WebImportError(data.error || `The page couldn't be fetched (${response.status}).`);
        error.browserRecommended = [401, 403, 429].includes(data.upstreamStatus ?? response.status) || purpose === "page" && response.status >= 500;
        throw error;
      }
      return {
        url,
        finalUrl: response.headers.get("x-final-url") || url,
        contentType: response.headers.get("content-type") || "",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    assetUrl(url, referer) {
      return endpoint({ url, purpose: "asset", referer });
    },
  };
}
