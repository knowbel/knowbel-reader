import test from "node:test";
import assert from "node:assert/strict";
import { nativeDocumentFormat, parseDocument, registerDocumentAdapter, releaseDocument } from "./registry.ts";
import { prepareDocument, unpreparedBlock } from "./prepare.ts";
import { DocumentEngine } from "./engine.ts";
import { resolveAnchor } from "./anchors.ts";
import { importFiles } from "../library/importFiles.ts";
import { createMemoryStorage } from "../storage/memory.ts";

test("a newly registered format inherits import, indexing, semantic objects and text anchors", async () => {
  let loaded = 0;
  let parsed = 0;
  // A fixture adapter, not an HTML implementation: test the common format
  // boundary without depending on any browser or format-specific renderer.
  registerDocumentAdapter({ format: "html", extensions: [".html"], mimeTypes: ["text/html"], load: async () => {
    loaded++;
    return { format: "html", parse({ id }) {
      parsed++;
      return prepareDocument({ id, format: "html", title: "Adapter fixture", blocks: [
        unpreparedBlock({ type: "element", tag: "h1", children: [{ type: "text", value: "Fixture section", start: 0 }] }),
        unpreparedBlock({ type: "element", tag: "p", children: [{ type: "text", value: "Searchable native passage.", start: 0 }] }),
        unpreparedBlock({ type: "image", src: "images/fixture.png", alt: "Fixture image", start: 0 }),
      ] });
    } };
  } });
  const file = new File(["source bytes of the fixture"], "fixture.html", { type: "text/html" });
  assert.equal(nativeDocumentFormat(file), "html");
  assert.equal(loaded, 0, "detecting a format does not load its parser");
  const storage = createMemoryStorage();
  const imported = await importFiles(storage, [file]);
  const meta = imported.added[0];
  assert.equal(meta.format, "html");
  const input = { id: meta.docId, bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name };
  const document = await parseDocument("html", input);
  assert.equal(parsed, 1, "opening shares the result of importing");
  assert.equal(document.objects[0].kind, "image");
  const engine = new DocumentEngine(document);
  const match = engine.search("native passage")[0];
  assert.ok(resolveAnchor(document, match.anchor));
  assert.equal((await engine.getSections())[0].title, "Fixture section");
  assert.deepEqual(await storage.getFile(meta.docId), input.bytes);
  releaseDocument(meta.docId);
  await parseDocument("html", input);
  assert.equal(parsed, 2, "closing releases the bounded document cache");
});
