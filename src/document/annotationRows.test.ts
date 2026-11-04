import test from "node:test";
import assert from "node:assert/strict";
import { markdownAdapter } from "../markdown/adapter.ts";
import { annotationRangeAt, groupAnnotationRows, studyAnnotationRows, type AnnotationRow } from "../annotations/model.ts";
import { nativeAnnotationRows, nativeAnnotationSections } from "./annotationRows.ts";
import { sameAnchor, textAnchor } from "./anchors.ts";
import type { AskThread } from "../ask/types.ts";
import type { DocumentAnnotation } from "./model.ts";

const document = markdownAdapter.parse({ id: "test", bytes: new TextEncoder().encode("# Study\n\nFirst passage.\n\n## Methods\n\nSecond passage.\n\n![](figure.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Methods\n\nLast passage."), fileName: "Study.md" });
function annotation(index: number, overrides: Partial<DocumentAnnotation> = {}): DocumentAnnotation {
  const block = document.blocks[index];
  return { id: `a-${index}`, kind: "highlight", anchor: textAnchor(document, { blockId: block.id, offset: 0 }, { blockId: block.id, offset: 5 }),
    text: block.text.slice(0, 5), comment: "Attached note", color: "#ffe08a", style: "highlight", createdAt: "2026-01-01T00:00:00Z", ...overrides };
}
function diveThread(item: DocumentAnnotation, changes: Partial<AskThread> = {}): AskThread {
  return { id: "saved-dive", title: "Existing dive", mode: "dive", anchor: item.anchor, turns: [], createdAt: item.createdAt, updatedAt: item.createdAt, ...changes };
}
const noop = () => {};
const handlers = { onOpen: noop, onDelete: noop, onEdit: noop, onOpenDive: noop };

test("native cards edit sticky-note content and highlight comments through their original IDs", () => {
  const highlight = annotation(1);
  const sticker = annotation(3, { kind: "sticker", comment: "My own words" });
  const events: unknown[] = [];
  const rows = nativeAnnotationRows(document, [sticker, highlight], { activeId: highlight.id,
    onOpen: (anchor) => events.push(anchor), onOpenDive: (id) => events.push(id),
    threads: [diveThread(highlight)],
    onDelete: (id) => events.push(id), onEdit: (id, text) => events.push([id, text]),
  });
  assert.equal(rows[0].kind, "sticky");
  assert.equal(rows[0].text, "My own words");
  assert.equal(rows[0].comment, undefined);
  assert.equal(rows[0].editsText, true);
  assert.equal(rows[1].comment, "Attached note");
  assert.equal(rows[1].isActive, true);
  assert.equal(rows[1].locationLabel, "Study");
  rows[0].onEdit("Revised sticky");
  rows[1].onEdit("");
  rows[1].onOpen!();
  rows[1].onOpenDive!();
  rows[0].onDelete();
  assert.deepEqual(events, [[sticker.id, "Revised sticky"], [highlight.id, ""], highlight.anchor, "saved-dive", sticker.id]);
  assert.equal(sticker.comment, "My own words", "projection does not mutate stored notes");
  const empty = nativeAnnotationRows(document, [{ ...sticker, comment: "" }], handlers)[0];
  assert.equal(empty.textIsPlaceholder, true);
});

test("native image/table anchors become area cards; unresolved notes remain editable", () => {
  const objects = document.objects.map((object, index) => annotation(1, {
    id: `object-${index}`, text: "", anchor: { kind: "object", objectId: object.id, blockId: object.blockId },
  }));
  const missing = annotation(1, { id: "missing", anchor: { kind: "object", objectId: "removed", blockId: "removed" } });
  const rows = nativeAnnotationRows(document, [...objects, missing], handlers);
  assert.equal(rows[0].kind, "area");
  assert.equal(rows[0].text, "Image");
  assert.equal(rows[0].textIsPlaceholder, true);
  assert.equal(rows[1].text, "Table 1");
  assert.ok(rows[1].position! > rows[0].position!);
  assert.equal(rows[2].position, undefined);
  assert.equal(rows[2].locationLabel, "Location unavailable");
  assert.equal(rows[2].onOpen, undefined);
  assert.equal(rows[2].onOpenDive, undefined);
  assert.equal(typeof rows[2].onEdit, "function");
});

test("shared document ordering uses section boundaries and offsets, including repeated headings", () => {
  const sections = nativeAnnotationSections(document);
  const first = annotation(1);
  const middle = annotation(3);
  const last = annotation(document.blocks.length - 1);
  const laterOffset = { ...first, id: "later", anchor: textAnchor(document, { blockId: document.blocks[1].id, offset: 6 }, { blockId: document.blocks[1].id, offset: 10 }) };
  const rows = nativeAnnotationRows(document, [last, laterOffset, middle, first], handlers);
  const groups = groupAnnotationRows(rows, "document", sections, () => "Unsectioned");
  assert.deepEqual(groups.map((group) => group.title), ["Study", "Methods", "Methods"]);
  assert.notEqual(groups[1].key, groups[2].key);
  assert.deepEqual(groups[0].rows.map((row) => row.id), [first.id, "later"]);
  assert.deepEqual(annotationRangeAt(sections, 2), [1, 2]);
  assert.deepEqual(annotationRangeAt(sections, 4), [3, sections[2].position - 1]);
  assert.deepEqual(annotationRangeAt(sections, document.blocks.length), [sections[2].position, Infinity]);
  assert.deepEqual(annotationRangeAt([{ title: "Later", position: 5 }], 2), [1, 4]);
  assert.equal(annotationRangeAt([], 1), null);
});

test("shared grouping accepts PDF labels without interpreting coordinates and sorts recent notes", () => {
  const base: AnnotationRow = { id: "early", kind: "highlight", position: 1, locationLabel: "p. iv", top: 0.1, sourceIndex: 0, text: "Quote", isActive: false, onDelete: noop, onEdit: noop };
  const rows = [{ ...base, id: "new", createdAt: "2026-01-02T00:00:00Z" }, { ...base, id: "old", createdAt: "2026-01-01T00:00:00Z" }, base];
  assert.equal(groupAnnotationRows(rows, "document", null, () => "Page iv")[0].title, "Page iv");
  assert.equal(groupAnnotationRows(rows, "document", null, () => "Page iv")[0].showLocation, false);
  assert.deepEqual(groupAnnotationRows(rows, "recent", null, String).flatMap((group) => group.rows.map((row) => row.id)), ["new", "old", "early"]);
});

test("both readers share pin/general-note edits and keep them separate from anchored annotations", () => {
  const events: unknown[] = [];
  const rows = studyAnnotationRows({ pins: [{ id: "pin", text: "Saved\npassage", context: "A study answer", comment: "Pin note", createdAt: "2026-01-01" }],
    notes: [{ id: "note", text: "Document note", createdAt: "2026-01-02" }],
    onDeletePin: (id) => events.push(id), onEditPin: (id, text) => events.push([id, text]),
    onDeleteNote: (id) => events.push(id), onEditNote: (id, text) => events.push([id, text]),
  });
  assert.equal(rows[0].text, "Saved passage");
  assert.equal(rows[0].context, "A study answer");
  assert.equal(rows[1].editsText, true);
  assert.ok(rows.every((row) => row.deleteWarning));
  assert.deepEqual(groupAnnotationRows(rows, "document", null, String).map((group) => group.title), ["General notes", "Other annotations"]);
  rows[0].onEdit("Edited pin note"); rows[1].onEdit("Edited document note"); rows[0].onDelete(); rows[1].onDelete();
  assert.deepEqual(events, [["pin", "Edited pin note"], ["note", "Edited document note"], "pin", "note"]);
});

test("native hover feedback identifies the annotation, and anchor identity reopens the same passage", () => {
  const item = annotation(1);
  const events: unknown[] = [];
  const [row] = nativeAnnotationRows(document, [item], { ...handlers, onHover: (id) => events.push(id) });
  row.onHover!(true); row.onHover!(false);
  assert.deepEqual(events, [item.id, null]);
  assert.equal(sameAnchor(item.anchor, { ...item.anchor, quote: "another saved quote" } as typeof item.anchor), true);
  assert.equal(sameAnchor(item.anchor, annotation(3).anchor), false);
  const object = document.objects[0];
  const anchor = { kind: "object" as const, blockId: object.blockId, objectId: object.id };
  assert.equal(sameAnchor(anchor, { ...anchor }), true);
  assert.equal(sameAnchor(anchor, { ...anchor, objectId: "another" }), false);
  assert.equal(sameAnchor(anchor, item.anchor), false);
});

test("the Dive badge is present only for an associated root dive and opens its existing thread", () => {
  const item = annotation(1);
  const events: string[] = [];
  const project = (threads: AskThread[]) => nativeAnnotationRows(document, [item], { ...handlers, threads, onOpenDive: (id) => events.push(id) })[0];
  assert.equal(project([]).onOpenDive, undefined);
  assert.equal(project([diveThread(item, { mode: undefined })]).onOpenDive, undefined, "ordinary Ask threads are not dives");
  assert.equal(project([diveThread(annotation(3))]).onOpenDive, undefined, "another passage's dive does not add a badge");
  assert.equal(project([diveThread(item, { parentThreadId: "parent" })]).onOpenDive, undefined, "nested answer dives are not passage associations");
  project([diveThread(item)]).onOpenDive!();
  assert.deepEqual(events, ["saved-dive"], "the badge opens by thread ID rather than creating a conversation");
  assert.equal(project([]).onOpenDive, undefined, "removing the conversation removes the badge");
});
