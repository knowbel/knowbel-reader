let prepare: (() => Promise<unknown>) | undefined;

export function registerReaderTransition(handler: () => Promise<unknown>): () => void {
  prepare = handler;
  return () => { if (prepare === handler) prepare = undefined; };
}

// An external open must wait for the same saves as leaving through the UI.
// Rejecting keeps the current reader mounted so the user can retry saving.
export async function prepareReaderTransition(): Promise<void> {
  await prepare?.();
}
