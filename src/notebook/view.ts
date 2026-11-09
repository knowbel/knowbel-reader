// Workspace preferences are independent of notebook revisions and AI jobs.
export interface NotebookView {
  activeId?: string | null;
  scrollTop?: number;
  query?: string;
  filter?: string;
  color?: string;
  sort?: string;
  selections?: Record<string, { from: number; to: number }>;
}
const views = new Map<string, NotebookView>();
export function notebookView(docId: string): NotebookView {
  if (!views.has(docId)) {
    try { views.set(docId, JSON.parse(localStorage.getItem(`knowbel-notebook-view:${docId}`) ?? '{}')); }
    catch { views.set(docId, {}); }
  }
  return views.get(docId)!;
}
export function rememberNotebookView(docId: string, patch: Partial<NotebookView>) {
  const value = { ...notebookView(docId), ...patch };
  views.set(docId, value);
  try { localStorage.setItem(`knowbel-notebook-view:${docId}`, JSON.stringify(value)); } catch { /* optional view preference */ }
}
