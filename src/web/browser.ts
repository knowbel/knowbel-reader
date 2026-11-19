import { invoke } from "@tauri-apps/api/core";
import type { RenderedArticlePage } from "./types.ts";
import { parseUserUrl } from "./url.ts";
export interface PageBounds { x: number; y: number; width: number; height: number }
export interface PageSelection { text: string; prefix: string; suffix: string; url: string; scrollY: number }
// A trusted action from the page's selection toolbar, tools or shortcuts.
export interface PageInteraction extends PageSelection {
  // "settled" comes from the page itself once it has finished loading.
  action: "highlight" | "pen" | "note" | "open-note" | "ask" | "dive" | "open-dive" | "glossary" | "delete" | "pin" | "key" | "settled";
  annotationId?: string; color?: string; style?: "highlight" | "underline" | "strikethrough";
  key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}
export interface PageQuote { text: string; prefix: string; suffix: string }
export interface PageMark extends PageQuote { id: string; color: string; style: string; kind: string; paper?: string; diveId?: string }
export interface PageSettings { tool: string; color: string; style: string; activeDiveId: string | null }
let operations: Promise<unknown> = Promise.resolve();
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const result = operations.catch(() => {}).then(work);
  operations = result; return result;
}
// `archive` opens a blank view for loadPageArchive instead of the live page.
export function openImportBrowser(url: string, owner: string, bounds: PageBounds, archive = false) {
  const parsed = parseUserUrl(url);
  if (!parsed || parsed.username || parsed.password) return Promise.reject(new Error("Enter a valid web address without embedded credentials."));
  return ordered(() => invoke<boolean>("open_import_browser", { url: parsed.href, owner, bounds, archive }));
}
// The page as WebKit loaded it, with the server's original document, for
// offline replay. Bytes travel as raw IPC data rather than JSON.
export async function savePageArchive(owner: string) {
  return new Uint8Array(await invoke<ArrayBuffer>("save_page_archive", { owner }));
}
export function loadPageArchive(owner: string, url: string, bytes: Uint8Array) {
  return ordered(() => invoke<void>("load_page_archive", bytes, { headers: { "x-knowbel-owner": owner, "x-knowbel-url": url } }));
}
export function positionPage(owner: string, bounds: PageBounds, visible: boolean) {
  return ordered(() => invoke<void>("position_import_browser", { owner, bounds, visible }));
}
export function browserAction(owner: string, action: "back" | "forward" | "reload" | "focus" | "reader-focus" | "close" | "hide" | "show" | "print" | "navigate" | "zoom" | "scroll", url?: string) {
  return ordered(() => invoke<void>("import_browser_action", { owner, action, url }));
}
export async function captureImportBrowser(owner: string): Promise<RenderedArticlePage> {
  const page = await invoke<RenderedArticlePage>("capture_import_browser", { owner });
  if (!parseUserUrl(page.url) || typeof page.html !== "string" || page.html.length > 16 * 1024 * 1024) throw new Error("The page returned an invalid article.");
  return page;
}
export function readPageSelection(owner: string) { return invoke<PageSelection>("read_page_selection", { owner }); }
export function readPageInteraction(owner: string) { return invoke<PageInteraction | null>("read_page_interaction", { owner }); }
export function decoratePage(owner: string, marks: PageMark[], focus: PageQuote | null, settings: PageSettings) {
  return invoke<{ found: boolean; marked: number }>("decorate_page", { owner, marks, focus, settings });
}
