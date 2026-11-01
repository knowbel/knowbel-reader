import test from "node:test";
import assert from "node:assert/strict";
import { Event, parseHTML } from "linkedom";
import { retryScrollRestoration } from "./scrollRestoration.ts";

function pane() {
  const { document } = parseHTML('<html><body><div id="pane"></div><button>Next page</button></body></html>');
  const container = document.getElementById("pane")!;
  return { document, container };
}

test("restoration keeps correcting while pages settle, including after programmatic scrolls", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container } = pane();
  let corrections = 0;
  const stop = retryScrollRestoration(container, () => { corrections++; });
  t.after(stop);

  t.mock.timers.tick(500);
  assert.equal(corrections, 1);
  container.dispatchEvent(new Event("scroll"));
  t.mock.timers.tick(6500);
  assert.equal(corrections, 6);
});

for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
  test(`${type} permanently cancels opening-page and highlight corrections`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { document, container } = pane();
    let corrections = 0;
    const stop = retryScrollRestoration(container, () => { corrections++; });
    t.after(stop);
    t.mock.timers.tick(500);
    assert.equal(corrections, 1);

    // The PDF child arrives after the restore effect was installed. Input
    // must still be caught when it originates from that child or controls.
    const pdf = document.createElement("div");
    container.appendChild(pdf);
    const target = type === "keydown" || type === "pointerdown" ? document.querySelector("button")! : pdf;
    target.dispatchEvent(new Event(type, { bubbles: true }));
    t.mock.timers.tick(10000);
    assert.equal(corrections, 1);
  });
}

test("input before the viewer is ready prevents even the first correction", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container } = pane();
  let corrections = 0;
  const stop = retryScrollRestoration(container, () => { corrections++; });
  t.after(stop);
  container.dispatchEvent(new Event("wheel"));
  t.mock.timers.tick(10000);
  assert.equal(corrections, 0);
});

test("cleanup cancels old retries without stopping a new document's restoration", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container } = pane();
  let oldCorrections = 0;
  let newCorrections = 0;
  const stop = retryScrollRestoration(container, () => { oldCorrections++; });
  stop();
  const stopNew = retryScrollRestoration(container, () => { newCorrections++; });
  t.after(stopNew);
  t.mock.timers.tick(7000);
  assert.equal(oldCorrections, 0);
  assert.equal(newCorrections, 6);
});

test("a viewer that is not ready yet can succeed on later retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { container } = pane();
  let attempts = 0;
  let corrections = 0;
  const stop = retryScrollRestoration(container, () => {
    attempts++;
    if (attempts === 1) throw new Error("Viewer still loading");
    corrections++;
  });
  t.after(stop);
  t.mock.timers.tick(500);
  assert.equal(corrections, 0);
  t.mock.timers.tick(700);
  assert.equal(corrections, 1);
});
