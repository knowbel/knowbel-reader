import test from "node:test";
import assert from "node:assert/strict";
import { importFiles } from "./importFiles.ts";
import { exportNotes, importNotes, readingProgress } from "./library.ts";
import { createMemoryStorage } from "../storage/memory.ts";

const bytes = new TextEncoder().encode("# Quantum notes\n\nA qubit is a quantum bit.");
test("Markdown import keeps the original bytes, deduplicates renamed files, and relinks restored notes", async () => {
  const storage = createMemoryStorage();
  const file = new File([bytes], "notes.md", { type: "" });
  const progress: number[] = [];
  const imported = await importFiles(storage, [file], (done) => progress.push(done));
  assert.equal(imported.failed.length, 0);
  assert.equal(imported.added.length, 1);
  const meta = imported.added[0];
  assert.equal(meta.format, "markdown");
  assert.equal(meta.title, "Quantum notes");
  assert.equal(meta.pageCount, undefined);
  assert.deepEqual(await storage.getFile(meta.docId), bytes);
  assert.deepEqual(progress, [0, 1]);
  await storage.putData(meta.docId, "nativeAnnotations", [{ id: "h1", comment: "A note" }]);
  const duplicate = await importFiles(storage, [new File([bytes], "renamed.MARKDOWN", { type: "text/plain" })]);
  assert.equal(duplicate.alreadyThere[0].docId, meta.docId);
  assert.equal((await storage.listDocuments()).length, 1);

  const restored = createMemoryStorage();
  await importNotes(restored, await exportNotes(storage));
  assert.equal((await restored.getMeta(meta.docId))?.fileMissing, true);
  const relinked = await importFiles(restored, [file]);
  assert.equal(relinked.added[0].fileMissing, undefined);
  assert.equal(relinked.added[0].format, "markdown");
  assert.deepEqual(await restored.getData(meta.docId, "nativeAnnotations"), [{ id: "h1", comment: "A note" }]);
  assert.deepEqual(await restored.getFile(meta.docId), bytes);
  assert.deepEqual(readingProgress({ ...meta, openedAt: "2026-11-03T00:00:00Z", readingProgress: 0.4 }), { label: "40% read", fraction: 0.4 });
});

test("batch import reports unsupported files and preserves an empty Markdown document", async () => {
  const storage = createMemoryStorage();
  const imported = await importFiles(storage, [new File([""], "empty.md"), new File(["text"], "notes.txt")]);
  assert.deepEqual(imported.failed, ["notes.txt"]);
  assert.equal(imported.added[0].title, "empty");
  assert.equal(imported.added[0].byteLength, 0);
});
