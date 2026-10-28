import test from "node:test";
import assert from "node:assert/strict";
import { streamDiveReply } from "./api.ts";

test("dive streams require a completion frame and retain partial text on interruption", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"text":"partial"}\n\n'));
        controller.close();
      },
    }));
    let received = "";
    await assert.rejects(streamDiveReply({ system: "system", messages: [{ role: "user", content: "question" }], onText: (text) => { received += text; } }), /interrupted/);
    assert.equal(received, "partial");
  } finally {
    globalThis.fetch = original;
  }
});

test("dive streams forward cancellation and return the completed answer", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.signal, controller.signal);
      return new Response('data: {"text":"hello"}\n\ndata: {"done":true,"text":"hello"}\n\n');
    };
    const result = await streamDiveReply({ system: "system", messages: [{ role: "user", content: "question" }], signal: controller.signal, onText: () => {} });
    assert.equal(result, "hello");
  } finally {
    globalThis.fetch = original;
  }
});
