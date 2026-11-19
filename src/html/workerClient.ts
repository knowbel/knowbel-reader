import type { DocumentAdapter } from "../document/registry.ts";
import type { FlowDocument } from "../document/model.ts";
import { WorkerUnavailableError } from "../markdown/workerClient.ts";

export function parseInWorker(input: Parameters<DocumentAdapter["parse"]>[0]): Promise<FlowDocument> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" }); }
    catch { reject(new WorkerUnavailableError("Module workers are unavailable in this webview.")); return; }
    worker.onmessage = (event: MessageEvent<{ document?: FlowDocument; error?: string }>) => {
      worker.terminate();
      if (event.data.document) resolve(event.data.document);
      else reject(new Error(event.data.error || "Couldn't parse this HTML document."));
    };
    worker.onerror = () => { worker.terminate(); reject(new WorkerUnavailableError("The HTML worker couldn't start.")); };
    worker.onmessageerror = () => { worker.terminate(); reject(new WorkerUnavailableError("The HTML worker returned unreadable data.")); };
    const bytes = input.bytes.slice();
    worker.postMessage({ ...input, bytes }, [bytes.buffer]);
  });
}
