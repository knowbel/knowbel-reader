import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

// Bundle the browser job's extensionless imports just as the app does.
// Keep external packages resolvable from the project's node_modules.
const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "ask-job-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = join(directory, "job.mjs");
await build({
  stdin: { contents: `
    export { ask, newThread } from "./src/ask/job.ts";
    export { AskStore } from "./src/ask/store.ts";
    export { DocumentEngine } from "./src/document/engine.ts";
    export { markdownAdapter } from "./src/markdown/adapter.ts";
  `, resolveDir: root },
  outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent",
});
const { ask, newThread, AskStore, DocumentEngine, markdownAdapter } = await import(pathToFileURL(outfile).href);

const paper = `# The components of agent memory

Agent memory stores experience between sessions.

Dreaming runs during idle time, reviewing earlier transcripts, repairing incorrect notes, organizing a wiki, and preparing context for later sessions.

These operations change external memory rather than the trained model weights.`;

function setup(source = paper) {
  const parsed = markdownAdapter.parse({ id: "a".repeat(64), fileName: "memory.md", bytes: new TextEncoder().encode(source) });
  const provider = new DocumentEngine(parsed);
  const store = new AskStore();
  store.load([], () => {});
  const thread = newThread("Study question");
  store.add(thread);
  const context = { pdfDocument: provider, fileName: "memory.md", pageLabel: String, pageLabels: null, currentPage: 1 };
  return { provider, store, thread, context };
}

function captureRequests(t: TestContext, reply: (body: any) => string = () => "An explanation [S1].") {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const text = reply(body);
    return new Response(`data: ${JSON.stringify({ text })}\n\ndata: ${JSON.stringify({ done: true, text })}\n\n`);
  });
  return requests;
}

test("Ask sends the dreaming question and its supporting text to the model with native citations", async (t) => {
  const state = setup();
  const question = "What is the mechanism of dreaming in LLMs?";
  const requests = captureRequests(t, (body) => {
    const label = /<source id="([^"]+)"[^>]*>Dreaming runs/.exec(body.system)?.[1];
    assert.ok(label, "the actual request contains the explanation");
    return `Dreaming reviews transcripts and reorganizes stored memory [${label}].`;
  });
  await ask(state.store, state.thread.id, question, state.context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.at(-1).content, question);
  const answer = state.store.get(state.thread.id).turns.at(-1);
  assert.equal(answer.status, undefined);
  assert.equal(answer.basis.kind, "scope");
  assert.ok(answer.sources.every((source: any) => source.location?.kind === "text" && source.locationLabel));
  assert.match(answer.content, /\[S\d+\]/);
});

test("the model assesses an unrelated question instead of a keyword search refusing it", async (t) => {
  const state = setup();
  const requests = captureRequests(t, () => "[not-covered] The article doesn't explain photosynthesis.");
  await ask(state.store, state.thread.id, "What is photosynthesis?", state.context);
  assert.equal(requests.length, 1);
  assert.match(requests[0].system, /Dreaming runs/);
  const answer = state.store.get(state.thread.id).turns.at(-1);
  assert.equal(answer.status, undefined);
  assert.match(answer.content, /^\[not-covered\]/);
});

test("short-paper follow-ups reuse the complete source prefix", async (t) => {
  const state = setup();
  const requests = captureRequests(t);
  await ask(state.store, state.thread.id, "What is dreaming?", state.context);
  await ask(state.store, state.thread.id, "Why does it help?", state.context);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].system, requests[0].system);
  assert.equal(requests[1].messages.at(-1).content, "Why does it help?");
});

test("follow-ups preserve attached figure images when reusing full-paper context", async (t) => {
  const state = setup();
  const requests = captureRequests(t);
  const image = { mediaType: "image/png", data: "test-image" };
  await ask(state.store, state.thread.id, "Explain this figure.", state.context, {
    attachments: [{ id: "figure", kind: "region", text: "", pageNumber: 1, image }],
  });
  await ask(state.store, state.thread.id, "Why?", state.context);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.at(-1).images, [image]);
});

test("a question about another section doesn't inherit the previous section's figure", async (t) => {
  const state = setup(`${paper}\n\n## Another section\n\nThis section discusses a different topic.`);
  const requests = captureRequests(t);
  const image = { mediaType: "image/png", data: "test-image" };
  await ask(state.store, state.thread.id, "Explain this section's figure.", state.context, {
    attachments: [{ id: "figure", kind: "region", text: "", pageNumber: 1, image }],
  });
  const section = (await state.provider.getSections()).find((section: any) => section.title === "Another section");
  await ask(state.store, state.thread.id, "Explain this section.", { ...state.context, currentPage: section.pageNumber });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).images, undefined);
  assert.doesNotMatch(requests[1].system, />Dreaming runs/);
});

test("More detail retains the scope of the answer it expands", async (t) => {
  const state = setup(`${paper}\n\n## Another section\n\nThis section discusses a different topic.`);
  const requests = captureRequests(t);
  await ask(state.store, state.thread.id, "Explain this section.", state.context);
  const first = state.store.get(state.thread.id).turns.at(-1);
  await ask(state.store, state.thread.id, "More detail, please.", state.context, { reuseSources: true });
  const followUp = state.store.get(state.thread.id).turns.at(-1);
  assert.equal(first.scope.kind, "section");
  assert.deepEqual(followUp.scope, first.scope);
  assert.equal(requests[1].system, requests[0].system);
});

test("text extraction failures are errors rather than unsupported coverage claims", async (t) => {
  const state = setup();
  const requests = captureRequests(t);
  state.provider.getTextIndex = async () => { throw new Error("Extraction failed"); };
  await ask(state.store, state.thread.id, "What is dreaming?", state.context);
  assert.equal(requests.length, 0);
  const answer = state.store.get(state.thread.id).turns.at(-1);
  assert.equal(answer.status, "error");
  assert.match(answer.content, /Couldn't read the document text/);
  assert.match(answer.content, /Extraction failed/);
  assert.doesNotMatch(answer.content, /not-covered/);
});

test("a document without extractable text reports that limitation explicitly", async (t) => {
  const state = setup("");
  const requests = captureRequests(t);
  await ask(state.store, state.thread.id, "What is dreaming?", state.context);
  assert.equal(requests.length, 0);
  const answer = state.store.get(state.thread.id).turns.at(-1);
  assert.equal(answer.status, "error");
  assert.match(answer.content, /No readable text/);
  assert.doesNotMatch(answer.content, /not-covered/);
});

test("answering from general knowledge remains an explicit retry", async (t) => {
  const state = setup();
  const requests = captureRequests(t);
  await ask(state.store, state.thread.id, "What is photosynthesis?", state.context);
  await ask(state.store, state.thread.id, "", state.context, { retry: { generalAllowed: true } });
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0].system, /Don't reply \[not-covered\]/);
  assert.match(requests[1].system, /Don't reply \[not-covered\]/);
  assert.equal(state.store.get(state.thread.id).turns.length, 2);
});
