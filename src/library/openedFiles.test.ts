import test from "node:test";
import assert from "node:assert/strict";
import { watchOpenedFiles, type OpenedFile, type OpenedFilesBridge } from "./openedFiles.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for file-open processing");
}
function fixture(initial: OpenedFile[]) {
  const queue = [...initial];
  const listeners = new Set<() => void>();
  const read: number[] = [];
  const bridge: OpenedFilesBridge = {
    listen: async (wake) => { listeners.add(wake); return () => { listeners.delete(wake); }; },
    pending: async () => [...queue],
    read: async (id) => {
      const index = queue.findIndex((file) => file.id === id);
      assert.notEqual(index, -1, "A file-open request must only be consumed once");
      queue.splice(index, 1); read.push(id);
      if (id === 99) throw new Error("Permission denied");
      return new TextEncoder().encode(`# File ${id}`).buffer;
    },
  };
  return { bridge, read, listeners, push: (file: OpenedFile) => { queue.push(file); listeners.forEach((wake) => wake()); } };
}

test("cold and warm opens stay ordered when Finder delivers more files during import", async () => {
  const f = fixture([{ id: 1, name: "Power and Desire #1 日本語.HTML" }, { id: 2, name: "paper.pdf" }]);
  const gate = deferred<void>();
  const opened: string[] = [], errors: string[] = [];
  const stop = watchOpenedFiles(f.bridge, async (file) => {
    if (opened.length === 0) await gate.promise;
    assert.match(await file.text(), /^# File /);
    opened.push(file.name);
  }, (message) => errors.push(message));
  try {
    await until(() => f.read.length === 1);
    f.push({ id: 3, name: "another.md" });
    f.listeners.forEach((wake) => wake());
    gate.resolve();
    await until(() => opened.length === 3);
    assert.deepEqual(f.read, [1, 2, 3]);
    assert.deepEqual(opened, ["Power and Desire #1 日本語.HTML", "paper.pdf", "another.md"]);
    assert.deepEqual(errors, []);
  } finally { stop(); }
});

test("replacing a subscription during an in-flight read does not duplicate or overlap imports", async () => {
  const f = fixture([{ id: 1, name: "one.md" }, { id: 2, name: "two.md" }]);
  const gate = deferred<void>();
  const opened: string[] = [], errors: string[] = [];
  const report = (message: string) => errors.push(message);
  const stop = watchOpenedFiles(f.bridge, async (file) => { await gate.promise; opened.push(file.name); }, report);
  await until(() => f.read.length === 1);
  stop();
  const stopNext = watchOpenedFiles(f.bridge, async (file) => { opened.push(file.name); }, report);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.read, [1]);
    gate.resolve();
    await until(() => opened.length === 2);
    assert.deepEqual(opened, ["one.md", "two.md"]);
    assert.deepEqual(errors, []);
  } finally { stopNext(); }
});

test("a read or import failure reports the file and allows following documents to open", async () => {
  const f = fixture([{ id: 99, name: "unreadable.pdf" }, { id: 1, name: "broken.epub" }, { id: 2, name: "good.md" }]);
  const errors: string[] = [], opened: string[] = [];
  const stop = watchOpenedFiles(f.bridge, async (file) => {
    if (file.name === "broken.epub") throw new Error("Invalid EPUB");
    opened.push(file.name);
  }, (message) => errors.push(message));
  try {
    await until(() => opened.length === 1);
    assert.match(errors[0], /unreadable.pdf.*Permission denied/);
    assert.match(errors[1], /broken.epub.*Invalid EPUB/);
    assert.deepEqual(opened, ["good.md"]);
  } finally { stop(); }
});

test("unmounting before listener setup completes removes it and preserves the startup queue", async () => {
  const f = fixture([{ id: 1, name: "one.md" }]);
  const setup = deferred<() => void>();
  let removed = false;
  const stop = watchOpenedFiles({ ...f.bridge, listen: () => setup.promise }, async () => assert.fail("Opened after disposal"), assert.fail);
  stop();
  setup.resolve(() => { removed = true; });
  await until(() => removed);
  assert.deepEqual(f.read, []);
});
