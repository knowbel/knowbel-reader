import type { FlowAnchor, FlowDocument, TextPoint } from "../document/model.ts";
import { textAnchor } from "../document/anchors.ts";
import type { PageSelection } from "./browser.ts";
// Whitespace and invisible formatting characters are ignored on both sides:
// a live page's block boundaries (often no whitespace at all in minified
// markup) never match the saved text's separators exactly.
const blank = /[\s­​-‍⁠﻿]/u;
const strip = (text: string) => { let result = ""; for (const character of text) if (!blank.test(character)) result += character; return result; };
const indices = new WeakMap<FlowDocument, { text: string; points: TextPoint[] }>();
function index(document: FlowDocument) {
  let result = indices.get(document); if (result) return result;
  let text = ""; const points: TextPoint[] = [];
  for (const block of document.blocks) {
    for (let offset = 0; offset < block.text.length; offset++) {
      const character = block.text[offset];
      if (blank.test(character)) continue;
      text += character; points.push({ blockId: block.id, offset });
    }
  }
  result = { text, points }; indices.set(document, result); return result;
}
// A live selection is mapped back into the saved document only when its
// quotation/context resolves unambiguously. Page changes never move a note
// silently to another copy of the same phrase.
export function pageSelectionAnchor(document: FlowDocument, selection: Pick<PageSelection, "text" | "prefix" | "suffix">) {
  const needle = strip(selection.text); if (!needle) return null;
  const { text, points } = index(document), candidates: { at: number; score: number }[] = [];
  const prefix = strip(selection.prefix), suffix = strip(selection.suffix);
  let from = 0;
  while (candidates.length < 100) {
    const at = text.indexOf(needle, from); if (at < 0) break; from = at + 1;
    let score = 0;
    for (let i=1;i<=prefix.length&&at-i>=0;i++) { if(prefix[prefix.length-i]!==text[at-i])break; score++; }
    for (let i=0;i<suffix.length&&at+needle.length+i<text.length;i++) { if(suffix[i]!==text[at+needle.length+i])break; score++; }
    candidates.push({ at, score });
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best = candidates[0];
  if (!best || candidates.length >= 100 || candidates.length > 1 && (best.score < 8 || best.score === candidates[1].score)) return null;
  const start = points[best.at], last = points[best.at + needle.length - 1];
  return start && last ? textAnchor(document, start, { ...last, offset: last.offset + 1 }) : null;
}
// The quotation and context a live page needs to find a saved passage.
export function pageQuote(document: FlowDocument, anchor: FlowAnchor) {
  if (anchor.kind === "text") return { text: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix };
  const block = document.blocks.find((block) => block.id === anchor.blockId);
  const object = document.objects.find((object) => object.id === anchor.objectId && object.blockId === anchor.blockId);
  return block && object ? { text: block.text.slice(object.start, object.end), prefix: block.text.slice(Math.max(0, object.start - 48), object.start), suffix: block.text.slice(object.end, object.end + 48) } : null;
}
// Redirects commonly add or drop "www." and a trailing slash. A query string
// is compared only when the saved address has one.
export function samePage(current: string, saved: string) {
  try {
    const a = new URL(current), b = new URL(saved);
    const host = (url: URL) => url.host.replace(/^www\./u, ""), path = (url: URL) => url.pathname.replace(/\/+$/u, "");
    return a.protocol.replace("http:", "https:") === b.protocol.replace("http:", "https:") && host(a) === host(b) && path(a) === path(b) && (!b.search || a.search === b.search);
  } catch { return false; }
}
