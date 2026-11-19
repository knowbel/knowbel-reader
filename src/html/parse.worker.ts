import { htmlAdapter } from "./adapter.ts";
import type { DocumentAdapter } from "../document/registry.ts";

self.onmessage = async (event: MessageEvent<Parameters<DocumentAdapter["parse"]>[0]>) => {
  try { self.postMessage({ document: await htmlAdapter.parse(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Couldn't parse this HTML document." }); }
};
