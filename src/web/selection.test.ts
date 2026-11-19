import test from "node:test";
import assert from "node:assert/strict";
import { htmlAdapter } from "../html/adapter.ts";
import type { FlowDocument } from "../document/model.ts";
import { pageSelectionAnchor, samePage } from "./selection.ts";
const parse = (source: string) => htmlAdapter.parse({id:"page",bytes:new TextEncoder().encode(source),fileName:"page.html"}) as FlowDocument;
test("live selections map formatting and whitespace back to exact saved offsets", () => {
  const document = parse('<p>First <b>formatted</b> passage.</p><p>Second paragraph.</p>');
  const anchor = pageSelectionAnchor(document,{text:'formatted  passage.\n\nSecond',prefix:'First ',suffix:' paragraph.'});
  assert.equal(anchor?.quote,'formatted passage.\n\nSecond');
  assert.equal(anchor?.start.offset,6);
  assert.equal(anchor?.end.offset,6);
});
test("repeated live quotations require a unique context match", () => {
  const document = parse('<p>One earlier context. Same phrase. First ending.</p><p>Two later context. Same phrase. Second ending.</p>');
  assert.equal(pageSelectionAnchor(document,{text:'Same phrase.',prefix:'',suffix:''}),null);
  const anchor = pageSelectionAnchor(document,{text:'Same phrase.',prefix:'Two later context. ',suffix:' Second ending.'});
  assert.equal(anchor?.start.blockId,document.blocks[1].id);
  assert.equal(pageSelectionAnchor(document,{text:'New content not saved.',prefix:'',suffix:''}),null);
});
test("minified block boundaries and invisible characters still match", () => {
  const document = parse('<p>Scaling storage to one billion users.</p><p>Postgres sharding came later.</p>');
  const anchor = pageSelectionAnchor(document,{text:'one billion users.Post­gres sharding',prefix:'Scaling storage to',suffix:'came later.'});
  assert.equal(anchor?.start.blockId,document.blocks[0].id);
  assert.equal(anchor?.end.blockId,document.blocks[1].id);
  assert.equal(anchor?.quote,'one billion users.\n\nPostgres sharding');
});
test("page addresses compare across redirects without losing query identity", () => {
  assert.ok(samePage('https://www.openai.com/index/scaling/#part','https://openai.com/index/scaling'));
  assert.ok(!samePage('https://openai.com/index/other/','https://openai.com/index/scaling/'));
  assert.ok(!samePage('https://example.org/view?id=2','https://example.org/view?id=1'));
  assert.ok(samePage('https://example.org/post?utm_source=x','https://example.org/post'));
});
