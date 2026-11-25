import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memory.ts';
import { NotebookStore } from './store.ts';
import { captureEntryId, findRichNode, mergeNotebooks, migrateNotebook, richMarkdown, richText, textBody } from './model.ts';
import type { CommentedHighlight } from '../types.ts';
const DOC = 'a'.repeat(64);
const highlight = (id = 'h1'): CommentedHighlight => ({ id, type: 'text', content: {text:'A selected passage'}, comment:'My thought', createdAt:'2026-11-05T00:00:00Z', position:{boundingRect:{x1:1,y1:2,x2:3,y2:4,width:100,height:100,pageNumber:2},rects:[]} });

test('migration keeps every annotation kind, rich source identity, and malformed legacy records', () => {
  const {notebook} = migrateNotebook(DOC, {
    highlights:[highlight(),{...highlight('sticky'),type:'freetext',content:{text:'Sticky writing'}}],
    generalNotes:[{id:'n',text:'General writing',createdAt:'2026-11-05'}],
    pins:[{id:'p',text:'AI excerpt',context:'Earlier explanation',comment:'Useful',createdAt:'2026-11-05'}, null],
    nativeAnnotations:[{id:'native',kind:'highlight',anchor:{kind:'text',quote:'native',start:{blockId:'b',offset:0},end:{blockId:'b',offset:6},prefix:'',suffix:''},text:'native',comment:'Native writing',color:'yellow',style:'underline',createdAt:'2026-11-05'}],
    diveHighlights:[{id:'d',panelId:'panel',text:'AI words',comment:'My AI thought',createdAt:'2026-11-05'}],
  });
  assert.equal(notebook.entries.length,6);
  assert.equal(notebook.captures.length,5);
  assert.deepEqual(notebook.unparsed?.pins,[null]);
  assert.equal(richText(notebook.entries[0].body),'My thought');
  assert.equal(notebook.captures[0].pdf?.comment,undefined);
  assert.equal(richText(notebook.entries[1].body),'Sticky writing');
  assert.equal(notebook.captures.find(c=>c.id==='pin:p')?.position,undefined);
});

test('a migrated notebook is canonical; removal of a mark keeps its note and reload does not resurrect it', async () => {
  const storage=createMemoryStorage(); const store=new NotebookStore(storage);
  await store.load(DOC,{highlights:[highlight()]});
  store.setPdfHighlights([]);
  assert.equal(store.getPdfHighlights().length,0);
  assert.equal(richText(store.getSnapshot().entries[0].body),'My thought');
  await store.flush();
  const reopened=new NotebookStore(storage);
  await reopened.load(DOC,{highlights:[highlight()],notebook:await storage.getData(DOC,'notebook')});
  assert.equal(reopened.getPdfHighlights().length,0);
  assert.equal(reopened.getSnapshot().entries.length,1);
});

test('source and notebook editors share one body; style changes preserve rich formatting',async()=>{
  const storage=createMemoryStorage();const store=new NotebookStore(storage);await store.load(DOC,{highlights:[highlight()]});
  const id=captureEntryId('pdf:h1');
  const body={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Important',marks:[{type:'bold'}]}]}]};
  const marks=store.getPdfHighlights();store.updateBody(id,body);
  assert.equal(store.getPdfHighlights(),marks,'ordinary note typing does not rerender the PDF');
  assert.equal(marks[0].comment,'Important');
  store.setPdfHighlights(previous=>previous.map(h=>({...h,highlightColor:'pink'})));
  assert.deepEqual(store.getEntry(id)?.body,body);
  store.setPdfHighlights(previous=>previous.map(h=>({...h,comment:'Edited beside source'})));
  assert.equal(store.plain(store.getEntry(id)),'Edited beside source');
  await store.flush();
});

test('saved state tracks acknowledgements, failed writes retain the latest revision, and retry succeeds',async()=>{
  const storage=createMemoryStorage();const store=new NotebookStore(storage);await store.load(DOC,{});
  const put=storage.putData.bind(storage);let release:()=>void=()=>{};
  storage.putData=async(doc,kind,value)=>{await new Promise<void>(r=>{release=r});await put(doc,kind,value)};
  const id=store.addNote();store.updateBody(id,textBody('First'));
  const pending=store.flush();await Promise.resolve();
  assert.equal(store.getSaveState(),'saving');
  release();await pending;assert.equal(store.getSaveState(),'saved');
  storage.putData=async()=>{throw new Error('disk full')};store.updateBody(id,textBody('Newest writing'));
  await assert.rejects(store.flush(),/disk full/);assert.equal(store.getSaveState(),'error');
  assert.equal(store.plain(store.getEntry(id)),'Newest writing');
  storage.putData=put;await store.flush();assert.equal(store.getSaveState(),'saved');
});

test('inline exchanges update by stable identity, keep other paragraphs, and restore interrupted rather than auto-running',async()=>{
  const storage=createMemoryStorage();const store=new NotebookStore(storage);await store.load(DOC,{});
  const id=store.addNote();store.updateBody(id,{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before'}]},{type:'aiExchange',attrs:{id:'exchange',question:'Why?',status:'streaming',answer:'Partial'}},{type:'paragraph',content:[{type:'text',text:'After'}]}]});
  store.patchNode(id,'exchange',{answer:'A precise explanation'});
  assert.equal(findRichNode(store.getEntry(id)!.body,'exchange')?.attrs?.answer,'A precise explanation');
  assert.ok(richText(store.getEntry(id)!.body).includes('After'));
  await store.flush();const reopened=new NotebookStore(storage);await reopened.load(DOC,{notebook:await storage.getData(DOC,'notebook')});
  assert.equal(findRichNode(reopened.getEntry(id)!.body,'exchange')?.attrs?.status,'interrupted');
});

test('removing an inline question cancels its job, preserves writing and sources, and supports undo', async () => {
  const storage = createMemoryStorage(), store = new NotebookStore(storage);
  await store.load(DOC, { highlights: [highlight()] });
  const id = captureEntryId('pdf:h1');
  const before = textBody('Before').content![0], after = textBody('After').content![0];
  store.updateBody(id, { type: 'doc', content: [before, { type: 'blockquote', content: [
    { type: 'aiExchange', attrs: { id: 'exchange', question: 'Why?', status: 'streaming', pendingAnswer: 'Partial answer' } },
  ] }, after, { type: 'aiExchange', attrs: { id: 'other', question: 'Another question', status: 'idle' } }] });
  const job = store.startJob('exchange'), otherJob = store.startJob('other');
  store.removeExchange(id, 'exchange');
  const body = store.getEntry(id)!.body;
  assert.equal(findRichNode(body, 'exchange'), undefined);
  assert.ok(job.signal.aborted);
  assert.equal(store.isCurrentJob('exchange', job), false);
  assert.equal(otherJob.signal.aborted, false);
  assert.equal(body.content![0], before);
  assert.equal(body.content![2], after);
  assert.deepEqual(body.content![1], { type: 'blockquote', content: [{ type: 'paragraph' }] });
  assert.deepEqual(store.getEntry(id)!.captureIds, ['pdf:h1']);
  assert.equal(store.getPdfHighlights().length, 1);
  store.patchNode(id, 'exchange', { answer: 'Late output' });
  await store.flush();
  const reopened = new NotebookStore(storage);
  await reopened.load(DOC, { notebook: await storage.getData(DOC, 'notebook') });
  assert.equal(findRichNode(reopened.getEntry(id)!.body, 'exchange'), undefined);
  store.undo();
  const restored = findRichNode(store.getEntry(id)!.body, 'exchange');
  assert.equal(restored?.attrs?.status, 'interrupted');
  assert.equal(restored?.attrs?.pendingAnswer, 'Partial answer');
  assert.equal(store.isCurrentJob('exchange', job), false);
  store.cancelJobs();
  await store.flush();
});

test('deleting or undoing an entry preserves shared captures, prose edits, and provenance',async()=>{
  const storage=createMemoryStorage();const store=new NotebookStore(storage);await store.load(DOC,{highlights:[highlight()]});
  const first=store.getSnapshot().entries[0].id,second=store.addNote();
  store.updateEntry(second,{captureIds:['pdf:h1']});
  store.trash(first);assert.equal(store.getPdfHighlights().length,1);
  store.restore(first);store.move(first,'document');store.updateBody(first,textBody('Kept after structural undo'));store.undo();
  assert.equal(store.plain(store.getEntry(first)),'Kept after structural undo');
  const merged=store.combine([first,second]);assert.ok(merged);assert.equal(store.getEntry(merged!)?.captureIds.length,1);
  await store.flush();
});

test('notebook backup merge retains divergent bodies and tombstones and is idempotent',()=>{
  const first=migrateNotebook(DOC,{highlights:[highlight()]}).notebook;
  const incoming=structuredClone(first);incoming.entries[0].body=textBody('Different writing');
  const merged=mergeNotebooks(first,incoming);assert.equal(merged.entries.length,2);
  assert.equal(mergeNotebooks(merged,incoming).entries.length,2);
  const deleted=structuredClone(first);deleted.entries[0].deletedAt='2026-11-06';
  assert.equal(mergeNotebooks(deleted,first).entries[0].deletedAt,'2026-11-06');
});

test('portable Markdown preserves formatting, image references, code, and inline exchanges',()=>{
  const content={type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Thoughts'}]},{type:'image',attrs:{assetId:'image.png',alt:'Diagram'}},{type:'codeBlock',attrs:{language:'ts'},content:[{type:'text',text:'const x = 1;'}]},{type:'aiExchange',attrs:{question:'Why?',answer:'Because [S1].',sources:[{label:'S1',pageNumber:2,start:0,end:5,text:'Proof'}]}}]};
  const md=richMarkdown(content);assert.ok(md.includes('## Thoughts'));assert.ok(md.includes('assets/image.png'));assert.ok(md.includes('```ts'));assert.ok(md.includes('**Question:** Why?'));assert.ok(md.includes('p. 2'));
});

test('undo reverses combining notes and retains only writing made after the command',async()=>{
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  const a=store.addNote(),b=store.addNote();store.updateBody(a,textBody('First'));store.updateBody(b,textBody('Second'));
  store.combine([a,b]);assert.equal(store.plain(store.getEntry(a)),'First\nSecond');
  store.undo();assert.equal(store.plain(store.getEntry(a)),'First');assert.equal(store.getEntry(b)?.deletedAt,undefined);
  await store.flush();
});

test('undoing a new source retains later writing and its source snapshot without leaving the highlight',async()=>{
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  store.setPdfHighlights([highlight()]);const entry=store.getSnapshot().entries[0];store.updateBody(entry.id,textBody('A later independent thought'));
  store.undo();assert.equal(store.getPdfHighlights().length,0);assert.equal(store.plain(store.getEntry(entry.id)),'A later independent thought');
  assert.equal(store.getCapture(entry.captureIds[0])?.text,'A selected passage');await store.flush();
});

test('image assets are acknowledged first and are not rewritten when text or highlight styles change',async()=>{
  const storage=createMemoryStorage(),writes:string[]=[];const put=storage.putData.bind(storage);
  storage.putData=async(doc,kind,value)=>{writes.push(kind);await put(doc,kind,value)};
  const store=new NotebookStore(storage);await store.load(DOC,{highlights:[{...highlight(),type:'area',content:{image:'data:image/png;base64,aGVsbG8='}}]});
  assert.deepEqual(writes.slice(0,2),['notebookAssets','notebook']);
  const assets=store.getAssets();store.updateBody(store.getSnapshot().entries[0].id,textBody('Image observation'));
  store.setPdfHighlights(marks=>marks.map(mark=>({...mark,highlightColor:'pink'})));await store.flush();
  assert.equal(store.getAssets(),assets);assert.equal(writes.filter(kind=>kind==='notebookAssets').length,1);
});

test('question drafts and their attachments stay scoped and survive reopening without changing notebook content',async()=>{
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  const notebook=store.getSnapshot();store.drafts!.set('ask:a','Why this assumption?');
  store.drafts!.setAttachments('ask:a',[{id:'attachment',kind:'document',text:'Exact source',pageNumber:2}]);
  assert.equal(store.getSnapshot(),notebook,'draft typing does not rebuild notebook entries');
  assert.equal(store.getSaveState(),'saving');await store.flush();assert.equal(store.getSaveState(),'saved');
  const reopened=new NotebookStore(storage);await reopened.load(DOC,{notebook:await storage.getData(DOC,'notebook'),readerDrafts:await storage.getData(DOC,'readerDrafts')});
  assert.equal(reopened.drafts!.get('ask:a'),'Why this assumption?');assert.equal(reopened.drafts!.get('ask:b'),'');assert.equal(reopened.drafts!.getAttachments('ask:a')[0].text,'Exact source');
});

test('a newer revision cannot appear saved while an earlier write finishes',async()=>{
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  const put=storage.putData.bind(storage),releases:Array<()=>void>=[];
  storage.putData=async(doc,kind,value)=>{await new Promise<void>(resolve=>releases.push(resolve));await put(doc,kind,value)};
  const id=store.addNote();store.updateBody(id,textBody('First revision'));const saving=store.flush();await Promise.resolve();
  store.updateBody(id,textBody('Second revision'));releases[0]();
  for(let i=0;i<10&&releases.length<2;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(store.getSaveState(),'saving');assert.equal(releases.length,2);releases[1]();await saving;
  assert.equal(store.getSaveState(),'saved');assert.equal(richText((await storage.getData<any>(DOC,'notebook')).entries[0].body),'Second revision');
});

test('combining AI and personal writing keeps block provenance and stable sources', async () => {
  const store = new NotebookStore(createMemoryStorage()); await store.load(DOC, {});
  const source = {label:'S1',pageNumber:2,start:0,end:5,text:'Original evidence'};
  const a = store.addNote(); store.updateBody(a, textBody('My interpretation'));
  const b = store.addExcerpt('Explanation [S1]', {conversationId:'conversation',turnId:'turn',sources:[source]}, textBody('Explanation'));
  store.combine([a,b]);
  const body = store.getEntry(a)!.body;
  assert.equal(store.getEntry(a)?.origin, undefined, 'mixed note has no whole-note AI label');
  assert.equal(body.content![0].type, 'paragraph');
  const contribution = body.content!.find(node => node.type === 'contribution');
  assert.equal(contribution?.attrs?.origin.turnId, 'turn');
  assert.deepEqual(contribution?.attrs?.origin.sources, [source]);
  assert.ok(richMarkdown(body).includes('AI-assisted')); await store.flush();
});

test('finishing a blank note removes it, while images, tables, and unanswered questions remain', async () => {
  const store = new NotebookStore(createMemoryStorage()); await store.load(DOC, {});
  const blank = store.addNote(); store.finishEntry(blank); assert.equal(store.getEntry(blank), undefined);
  for (const node of [{type:'image',attrs:{assetId:'image'}},{type:'aiExchange',attrs:{id:'q',question:''}},{type:'table',content:[]}]) {
    const id = store.addNote('document', undefined, {type:'doc',content:[node]}); store.finishEntry(id); assert.ok(store.getEntry(id));
  }
  await store.flush();
});

test('attaching a saved passage shares its source without changing either body or mark identity', async () => {
  const store = new NotebookStore(createMemoryStorage()); await store.load(DOC, {highlights:[highlight()]});
  const id = store.addNote(); store.updateBody(id,textBody('My synthesis')); store.attachCapture(id,'pdf:h1'); store.attachCapture(id,'pdf:h1');
  assert.equal(store.getEntry(id)!.captureIds.length,1); assert.equal(store.getPdfHighlights().length,1);
  assert.equal(store.plain(store.getEntry(id)),'My synthesis');
  store.trash(store.getSnapshot().entries[0].id); assert.equal(store.getPdfHighlights().length,1);
  await store.flush();
});

test('portable bundle round-trips rich questions, provenance, source captures, and images with readable export names', async () => {
  const {notebookBundle,readNotebookBundle} = await import('./export.ts');
  const {unzipSync,strFromU8} = await import('fflate');
  const store = new NotebookStore(createMemoryStorage()); await store.load(DOC, {highlights:[highlight()]});
  const id = store.addNote(), assetId = store.addImageDataUrl('data:image/png;base64,aGVsbG8=', 'pdf:figure');
  store.updateBody(id, {type:'doc',content:[{type:'image',attrs:{assetId}},{type:'blockMath',attrs:{latex:'E=mc^2'}},{type:'aiExchange',attrs:{id:'q',question:'Why?',answer:'Because [S1]',sources:[{label:'S1',pageNumber:2,text:'Evidence',start:0,end:8}],editedBody:textBody('My edited explanation')}}]});
  const zip = notebookBundle(store.getSnapshot(),store.getAssets(),'My notebook');
  const files = unzipSync(zip), imagePath = Object.keys(files).find(path=>path.endsWith('.png'))!;
  assert.ok(imagePath.startsWith('assets/')); assert.ok(strFromU8(files['notebook.md']).includes(imagePath));
  assert.ok(strFromU8(files['notebook.md']).includes('My edited explanation'));
  const bundle = await readNotebookBundle(new File([zip as Uint8Array<ArrayBuffer>],'notebook.zip'));
  assert.deepEqual(bundle.document,JSON.parse(JSON.stringify(store.getSnapshot()))); assert.deepEqual(bundle.assets,store.getAssets());
  const reopened = new NotebookStore(createMemoryStorage()); await reopened.load(DOC, {}); reopened.importNotebook(bundle.document,bundle.assets);
  assert.equal(reopened.assetDataUrl(assetId),'data:image/png;base64,aGVsbG8='); await store.flush(); await reopened.flush();
});

test('HTML exports are self-contained, preserve technical formatting, and escape untrusted content', async () => {
  const {notebookHTML} = await import('./htmlExport.ts');
  const store = new NotebookStore(createMemoryStorage()); await store.load(DOC, {});
  const image = store.addImageDataUrl('data:image/png;base64,aGVsbG8=');
  store.addNote('document', undefined, {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'<script>unsafe</script>',marks:[{type:'bold'},{type:'link',attrs:{href:'javascript:alert(1)'}}]}]},{type:'blockMath',attrs:{latex:'x^2'}},{type:'image',attrs:{assetId:image}},{type:'aiExchange',attrs:{question:'Explain',answer:'**Strong point** [S1]',sources:[{label:'S1',pageNumber:3,text:'Proof',start:0,end:5}]}}]});
  const html = notebookHTML(store.getSnapshot(),store.getAssets(),'Test');
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('<math')); assert.ok(html.includes('data:image/png;base64,aGVsbG8=')); assert.ok(html.includes('<strong>Strong point</strong>')); assert.ok(html.includes('p. 3'));
  await store.flush();
});

test('simultaneous flush callers share one serial drain and acknowledge the final revision', async () => {
  const storage=createMemoryStorage(),store=new NotebookStore(storage); await store.load(DOC,{});
  const put=storage.putData.bind(storage),releases:Array<()=>void>=[]; let active=0,maxActive=0;
  storage.putData=async(doc,kind,value)=>{active++;maxActive=Math.max(maxActive,active);await new Promise<void>(resolve=>releases.push(resolve));await put(doc,kind,value);active--};
  const id=store.addNote();store.updateBody(id,textBody('First'));
  const first=store.flush(),second=store.flush(),third=store.flush();await Promise.resolve();
  store.updateBody(id,textBody('Final'));releases[0]();
  for(let i=0;i<10&&releases.length<2;i++) await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(maxActive,1);assert.equal(releases.length,2);releases[1]();await Promise.all([first,second,third]);
  assert.equal(store.getSaveState(),'saved');assert.equal(richText((await storage.getData<any>(DOC,'notebook')).entries[0].body),'Final');
});

test('malformed anchored records are retained for recovery instead of crashing the reader', () => {
  const {notebook}=migrateNotebook(DOC,{highlights:[{id:'missing-geometry',content:{text:'Important'}}],nativeAnnotations:[{id:'missing-anchor',text:'Important'}],generalNotes:[{id:'missing-body'}]});
  assert.equal(notebook.entries.length,0);assert.equal(notebook.unparsed!.highlights.length,1);assert.equal(notebook.unparsed!.nativeAnnotations.length,1);assert.equal(notebook.unparsed!.generalNotes.length,1);
});

test('note context distinguishes reader assertions and earlier AI and excludes the active question', async () => {
  const {entryContext}=await import('./model.ts');
  const body={type:'doc',content:[textBody('My interpretation').content![0],{type:'aiExchange',attrs:{id:'old',question:'Earlier?',answer:'Old answer',editedBody:textBody('An edited answer')}},{type:'aiExchange',attrs:{id:'active',question:'Do not repeat me'}}]};
  const context=entryContext(body,'active');assert.ok(context.includes('Reader writing'));assert.ok(context.includes('Earlier AI-assisted'));assert.ok(context.includes('An edited answer'));assert.ok(!context.includes('Do not repeat me'));
});

test('a failed document migration leaves the current notebook and its later writes bound to the original document', async () => {
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  const id=store.addNote();store.updateBody(id,textBody('Original document writing'));await store.flush();
  const put=storage.putData.bind(storage),next='b'.repeat(64);
  storage.putData=async(doc,kind,value)=>{if(doc===next&&kind==='notebook')throw new Error('migration failed');await put(doc,kind,value)};
  await assert.rejects(store.load(next,{generalNotes:[{id:'new',text:'Other document'}]}),/migration failed/);
  assert.equal(store.docId,DOC);assert.equal(store.plain(store.getEntry(id)),'Original document writing');
  store.updateBody(id,textBody('Continued original writing'));await store.flush();
  assert.equal(richText((await storage.getData<any>(DOC,'notebook')).entries[0].body),'Continued original writing');
  assert.equal(await storage.getData(next,'notebook'),null);
});

test('legacy conversation IDs are persisted once and reused for notebook answer links', async () => {
  const {restorePanelTurns,createRootPanel,appendTurn}=await import('../deepdive/tree.ts');
  const {DocDataWriter}=await import('../storage/docDataWriter.ts');
  const panel=appendTurn(createRootPanel({anchorHighlightId:'h',selection:'Source',contextText:'Context'}),'assistant','Answer');
  const legacy=[{...panel,turns:panel.turns.map(({id:_id,...turn})=>turn)}];
  const normalized=restorePanelTurns(legacy);assert.ok(normalized.every(panel=>panel.turns.every(turn=>turn.id)));
  const storage=createMemoryStorage(),writer=new DocDataWriter(storage);writer.prime(DOC,'dives',legacy);writer.schedule(DOC,'dives',normalized);await writer.flush();
  const persisted=await storage.getData<any[]>(DOC,'dives');assert.deepEqual(persisted,normalized);assert.equal(restorePanelTurns(persisted!),persisted);
});

test('writing during a staged document open is drained before the previous session is replaced', async () => {
  const storage=createMemoryStorage(),store=new NotebookStore(storage);await store.load(DOC,{});
  const id=store.addNote();store.updateBody(id,textBody('First'));await store.flush();
  const put=storage.putData.bind(storage),next='c'.repeat(64);let release!:()=>void;
  storage.putData=async(doc,kind,value)=>{if(doc===next&&kind==='notebook')await new Promise<void>(resolve=>release=resolve);await put(doc,kind,value)};
  const opening=store.load(next,{});
  for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setTimeout(resolve,0));
  store.updateBody(id,textBody('Writing while the next document opens'));release();await opening;
  assert.equal(store.docId,next);assert.equal(richText((await storage.getData<any>(DOC,'notebook')).entries[0].body),'Writing while the next document opens');
});

test('recapturing an AI-answer occurrence reuses its linked note and preserves writing after mark removal', async () => {
  const store=new NotebookStore(createMemoryStorage());await store.load(DOC,{});
  const mark={panelId:'panel',text:'Repeated explanation',comment:'',turnIndex:2,occurrence:1};
  const id=store.captureDive(mark),entry=store.entryForCapture(`dive:${id}`)!;store.updateBody(entry.id,textBody('My explanation'));
  assert.equal(store.captureDive(mark),id);store.addNote();assert.equal(store.entryForCapture(`dive:${id}`)?.id,entry.id);
  assert.notEqual(store.captureDive({...mark,occurrence:2}),id,'the other occurrence is a different source');
  store.setDiveHighlights(marks=>marks.filter(mark=>mark.id!==id));assert.equal(store.captureDive(mark),id);
  assert.equal(store.plain(store.entryForCapture(`dive:${id}`)),'My explanation');await store.flush();
});

test('starting a dive from a restored answer highlight links the existing note', async () => {
  const store = new NotebookStore(createMemoryStorage());
  await store.load(DOC, {});
  const mark = { panelId: 'parent', text: 'A repeated phrase', comment: 'My note', turnIndex: 3, occurrence: 1, highlightStyle: 'underline' as const };
  const id = store.captureDive(mark);
  store.setDiveHighlights((marks) => marks.filter((item) => item.id !== id));

  assert.equal(store.captureDive({ ...mark, comment: '', divePanelId: 'child' }), id);
  assert.equal(store.getDiveHighlights().length, 1);
  assert.deepEqual(store.getDiveHighlights()[0], { ...mark, id, divePanelId: 'child', createdAt: store.getDiveHighlights()[0].createdAt });
  assert.equal(store.captureDive({ ...mark, divePanelId: 'another-child' }), id);
  assert.equal(store.getDiveHighlights()[0].divePanelId, 'another-child');
  assert.equal(store.plain(store.entryForCapture(`dive:${id}`)), 'My note');
});
