import test from "node:test";
import assert from "node:assert/strict";
import { prepareReaderTransition, registerReaderTransition } from "./readerTransition.ts";

test("external opens wait for active reader saves and propagate failures", async () => {
  let release!: () => void;
  const save = new Promise<void>((resolve) => { release = resolve; });
  const unregister = registerReaderTransition(() => save);
  let finished = false;
  const transition = prepareReaderTransition().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  release(); await transition;
  assert.equal(finished, true);
  unregister();
  const removeFailure = registerReaderTransition(async () => { throw new Error("Disk full"); });
  await assert.rejects(prepareReaderTransition(), /Disk full/);
  removeFailure();
  await prepareReaderTransition();
});

test("cleanup from a previous reader cannot unregister the current reader", async () => {
  const stale = registerReaderTransition(async () => assert.fail("Stale reader was flushed"));
  let flushed = false;
  const current = registerReaderTransition(async () => { flushed = true; });
  stale();
  await prepareReaderTransition();
  assert.equal(flushed, true);
  current();
});
