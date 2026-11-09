import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const origin=process.env.READER_URL || 'http://127.0.0.1:5178';
const version=await (await fetch((process.env.CDP_URL || 'http://127.0.0.1:9224')+'/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, {once:true}));
let seq = 0;
let sessionId;
const pending = new Map();
const errors = [];
const consoleErrors = [];
const requests = [];
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const task = pending.get(message.id); pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  else if (message.method === 'Runtime.consoleAPICalled' && message.params.type==='error') consoleErrors.push(message.params.args.map(arg=>arg.description || arg.value));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, {resolve,reject}); ws.send(JSON.stringify({id,method,params,...(sessionId && !method.startsWith('Target.')?{sessionId}:{})}));
});
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function wait(expression, message = expression) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: '+message+'\n'+(await evaluate('document.body.innerText.slice(0,6000)')));
}
async function click(selector) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing selector: '+${JSON.stringify(selector)}); el.click(); })()`);
}
async function fill(selector, text) {
  await evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});field.focus();field.select();})()`);
  if (text) await send('Input.insertText', {text});
  else await evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});const prototype=field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,'');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function select(text, occurrence=0) {
  await evaluate(`(() => {
    const text=${JSON.stringify(text)};
    const runs=[...document.querySelectorAll('.flow-document [data-reader-run]:not([data-reader-atomic])')];
    let which=0;
    for(const run of runs) {
      let from=0;
      while(true) {
        const at=run.textContent.indexOf(text,from); if(at<0) break; from=at+1;
        if(which++!==${occurrence}) continue;
        const walker=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let cursor=0,startNode,endNode,startOffset,endOffset;
        while(walker.nextNode()) {const node=walker.currentNode;const next=cursor+node.textContent.length;if(!startNode && at<next) {startNode=node;startOffset=at-cursor;} if(at+text.length<=next) {endNode=node;endOffset=at+text.length-cursor;break;}cursor=next;}
        const range=document.createRange();range.setStart(startNode,startOffset);range.setEnd(endNode,endOffset);
        window.getSelection().removeAllRanges();window.getSelection().addRange(range);
        run.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return;
      }
    }
    throw new Error('Text selection not found: '+text);
  })()`);
  await wait("!!document.querySelector('.dive-selection-tip')");
}
async function upload(source,name='Native test.md',type='text/markdown') {
  const value = Array.isArray(source) ? `new Uint8Array(${JSON.stringify(source)})` : JSON.stringify(source);
  await evaluate(`(() => { const input=document.querySelector('input[type=file]:not([accept*=json])'); const transfer=new DataTransfer();transfer.items.add(new File([${value}],${JSON.stringify(name)},{type:${JSON.stringify(type)}})); input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
const {browserContextId}=await send('Target.createBrowserContext');
const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});
({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));
try {
await send('Runtime.enable');await send('Network.enable');await send('Page.enable');await send('Page.bringToFront');await send('Emulation.setFocusEmulationEnabled',{enabled:true});
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:origin});
await wait("!!document.querySelector('.library-empty') || !!document.querySelector('.library')");
await evaluate(`window.__nativeRequests=[];window.__fetch=window.fetch;window.fetch=async function(url,opts) {
  const address=String(url);
  if(address.includes('/api/reference')) return new Response(JSON.stringify({dictionary:null,encyclopedia:[]}),{headers:{'Content-Type':'application/json'}});
  if(address.includes('/api/') && address.endsWith('/stream')) {
    window.__nativeRequests.push({url:address,body:JSON.parse(opts.body)});
    if(window.__holdAi) return new Promise((resolve,reject)=>{opts.signal.addEventListener('abort',()=>{window.__abortedAi=(window.__abortedAi||0)+1;reject(new DOMException('Aborted','AbortError'));},{once:true});});
    const answer=address.includes('/glossary/') ? 'SOURCE: defined\\nORIGIN: technical; quantum computing\\nA quantum bit stores quantum information.\\n---\\nDEFINED_IN: S1\\nALIASES: none\\nLITERAL: none\\nREFERENCE: none' : 'A qubit stores quantum information [S1].';
    const text=answer.replaceAll('\\\\n','\\n');
    return new Response('data: '+JSON.stringify({text})+'\\n\\ndata: '+JSON.stringify({done:true,text})+'\\n\\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  return window.__fetch(url,opts);
};`);
const source='# Native Study\n\nA qubit stores quantum information. Repeat target appears here. Repeat target appears again.\n\nUse **formatted** text and $E=mc^2$ in a passage.\n\n## Methods\n\n- [x] Done\n- [ ] Pending\n\n| Epoch | Loss |\n| --- | --- |\n| 1 | 0.2 |\n\n![Training curve](figures/curve.png)\n\n[Jump to results](#results)\n\n## Results\n\nThe experiment measures a qubit.\n\n'+Array.from({length:30},(_,i)=>`Paragraph ${i}: Read the surrounding explanation and preserve annotations across layout changes.\n`).join('\n');
await upload(source);
await wait("!!document.querySelector('.native-reader .flow-document h1')");
assert.equal(await evaluate("document.querySelector('.flow-document h1').textContent"),'Native Study');
// Both formats share the floating navigator, reveal rules, and jump history.
await wait("!!document.querySelector('.page-nav select[aria-label=\"Section\"]')");
assert.equal(await evaluate("document.querySelectorAll('.flow-header').length"),0);
assert.deepEqual(await evaluate("[...document.querySelector('.page-nav-section').options].map(option=>option.textContent)"),['Native Study','Methods','Results']);
await evaluate(`window.__navigatorStyle = () => {
  const nav=document.querySelector('.page-nav'), pane=nav.parentElement;
  const box=nav.getBoundingClientRect(), bounds=pane.getBoundingClientRect(), style=getComputedStyle(nav);
  return { centered:Math.abs((box.left+box.right)/2-(bounds.left+bounds.right)/2)<1,
    bottom:Math.round(bounds.bottom-box.bottom),radius:style.borderRadius,background:style.backgroundColor };
};`);
const nativeNavigationUi=await evaluate('window.__navigatorStyle()');
assert.ok(nativeNavigationUi.centered);
assert.equal(nativeNavigationUi.bottom,20);
await click('.page-nav button[aria-label="Next section"]');
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Methods'");
await click('.page-nav button[aria-label="Next section"]');
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Results'");
await click('.page-nav button[aria-label="Previous section"]');
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Methods'");
await click('.page-nav button[aria-haspopup="menu"]');
await wait("document.querySelectorAll('.page-nav-menu button').length>=3");
// A multi-step jump preserves the skipped entries in Forward.
await evaluate("document.querySelector('.page-nav-menu button:last-child').click()");
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Native Study'");
await click('.page-nav button[aria-label^="Forward to "]');
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Methods'");
await evaluate("const section=document.querySelector('.page-nav-section');section.value='0';section.dispatchEvent(new Event('change',{bubbles:true}));document.activeElement?.blur()");
await wait("document.querySelector('.page-nav-section').selectedOptions[0].textContent==='Native Study'");
assert.ok(await evaluate("document.querySelector('.page-nav button[aria-label=\"Forward\"]').disabled"),'a new section jump clears Forward');
await wait("!document.querySelector('.page-nav--visible')",'navigator fades while idle');
await evaluate("const nav=document.querySelector('.page-nav'),rect=nav.getBoundingClientRect();nav.parentElement.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:rect.left+5,clientY:rect.top+5}))");
await wait("!!document.querySelector('.page-nav--visible')",'pointer proximity reveals navigator');
await evaluate("document.querySelector('.flow-pane').dispatchEvent(new MouseEvent('mouseleave'))");
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'g',code:'KeyG',modifiers:5});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'g',code:'KeyG',modifiers:5});
await wait("document.activeElement===document.querySelector('.page-nav-section')");
await new Promise(resolve=>setTimeout(resolve,1700));
assert.ok(await evaluate("!!document.querySelector('.page-nav--visible')"),'keyboard focus keeps navigation visible');
await evaluate("document.activeElement.blur();document.querySelector('.flow-scroll').dispatchEvent(new Event('scroll'))");
await wait("!!document.querySelector('.page-nav--visible')",'scroll reveals navigator');
await evaluate("document.querySelector('.flow-document').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}))");
await wait("!document.querySelector('.page-nav--visible')",'selection drag hides navigator');
await evaluate("window.dispatchEvent(new PointerEvent('pointerup',{button:0}))");

assert.equal(await evaluate("document.querySelectorAll('.flow-document table').length"),1);
await wait("!!document.querySelector('.flow-document .katex')");
await wait("!!document.querySelector('.notebook-dock .nb-list')");
await select('Repeat target',1);
await click('.dive-selection-tip .TextHighlight__highlight-button');
await wait("!!document.querySelector('.flow-mark') && document.querySelectorAll('.nb-entry').length===1");
assert.equal(await evaluate("document.querySelector('.flow-mark').textContent"),'Repeat target');
// Selecting the same exact occurrence reuses its source capture.
await select('Repeat target',1);
await click('.dive-selection-tip .TextHighlight__highlight-button');
await wait("document.querySelectorAll('.nb-entry').length>=1");
assert.equal(await evaluate("document.querySelectorAll('.nb-entry').length"),1,'same source is captured once');
// Note immediately focuses rich writing, without another dialog.
await select('formatted');
await click('.dive-selection-tip .TextHighlight__comment-button');
await wait("!!document.querySelector('.nb-rich-editor')");
async function fillRich(selector,text) {
  await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.focus();const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
  await send('Input.insertText',{text});
}
await fillRich('.nb-rich-editor','A thought worth keeping');
await wait("document.querySelector('.nb-rich-editor')?.textContent.includes('A thought worth keeping')");
// Notebook writing must not mutate or rerender document content.
await evaluate("window.__documentMutations=0;window.__docObserver=new MutationObserver(records=>window.__documentMutations+=records.length);window.__docObserver.observe(document.querySelector('.flow-document'),{childList:true,subtree:true,characterData:true});");
await send('Input.insertText',{text:' while reading'});
await click('button[aria-label="Ask (⌘J)"]');
await wait("!!document.querySelector('.ask-composer textarea')");
await fill('.ask-composer textarea','Unsent question about qubit');
await click('button[aria-label="Glossary"]');
await click('button[aria-label="Ask (⌘J)"]');
await wait("document.querySelector('.ask-composer textarea')?.value==='Unsent question about qubit'");
assert.ok(await evaluate("document.querySelector('.nb-rich-editor')?.textContent.includes('A thought worth keeping while reading')"));
assert.equal(await evaluate('window.__documentMutations'),0,'ordinary note typing leaves the document DOM alone');
await evaluate('window.__docObserver.disconnect()');
await click('button[aria-label="Close question area"]');
await click('button[aria-label="Close notebook"]');
await click('button[aria-label="Notebook"]');
assert.ok(await evaluate("document.querySelector('.nb-rich-editor')?.textContent.includes('A thought worth keeping while reading')"));
// Sticky notes edit the same canonical notebook body.
await evaluate("document.querySelector('.flow-document p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
await wait("!!document.querySelector('.nb-entry.is-editing .nb-rich-editor')");
await fillRich('.nb-entry.is-editing .nb-rich-editor','Remember this passage');
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
await click('.nb-entry.is-editing .nb-editor-footer button');
// Technical rich content, including image paste, equations, and tables.
await click('button[aria-label="New note"]');
await wait("!!document.querySelector('.nb-entry.is-editing .nb-rich-editor')");
await click('.nb-entry.is-editing button[aria-label="Bold"]');
await fillRich('.nb-entry.is-editing .nb-rich-editor','Rich document note');
await wait("document.querySelector('.nb-entry.is-editing .nb-rich-editor strong')?.textContent==='Rich document note'");
await click('.nb-entry.is-editing button[aria-label="Bold"]');
await click('.nb-entry.is-editing button[aria-label="Insert equation"]');
await fill('input[aria-label="LaTeX equation"]','E=mc^2');
await evaluate("document.querySelector('.nb-insert-form button[type=submit]').click()");
await wait("!!document.querySelector('.nb-entry.is-editing .katex')");
await click('.nb-entry.is-editing button[aria-label="Insert table"]');
await wait("!!document.querySelector('.nb-entry.is-editing table')");
const png=await evaluate("(() => {const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);return canvas.toDataURL('image/png');})()");
await evaluate(`(() => {const bytes=Uint8Array.from(atob(${JSON.stringify(png)}.split(',')[1]),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'Notebook image.png',{type:'image/png'}));document.querySelector('.nb-entry.is-editing .nb-rich-editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));})()`);
await wait("document.querySelector('.nb-entry.is-editing .nb-rich-editor img[alt=\"Notebook image.png\"]')?.naturalWidth===32");
assert.ok(await evaluate("!!document.querySelector('.native-reader')"),'image paste does not import another document');
// Question deletion works in the editor and in saved notes, with undo in each view.
await evaluate("const rich=document.querySelector('.nb-entry.is-editing .nb-rich-editor').editor;rich.chain().insertContentAt(rich.state.doc.content.size,{type:'paragraph'}).focus('end').run()");
await click('.nb-entry.is-editing button[aria-label="Ask AI here"]');
await wait("!!document.querySelector('.nb-entry.is-editing .nb-ai-question')");
await click('.nb-entry.is-editing button[aria-label="Delete AI question"]');
await wait("!document.querySelector('.nb-ai-exchange')");
assert.ok(await evaluate("document.querySelector('.nb-entry.is-editing .nb-rich-editor strong')?.textContent==='Rich document note' && !!document.querySelector('.nb-entry.is-editing table') && !!document.querySelector('.nb-entry.is-editing .katex') && !!document.querySelector('.nb-entry.is-editing img')"),'deleting a question preserves the surrounding note');
await click('.nb-entry.is-editing button[aria-label="Undo"]');
await wait("!!document.querySelector('.nb-entry.is-editing .nb-ai-question')");
await click('.nb-entry.is-editing .nb-editor-footer button');
await click('.nb-entry-writing button[aria-label="Delete AI question"]');
await wait("!document.querySelector('.nb-ai-exchange')");
await evaluate("[...document.querySelectorAll('.nb-header-menu button')].find(b=>b.textContent.includes('Undo notebook action')).click()");
await wait("!!document.querySelector('.nb-entry-writing .nb-ai-question')");
await click('.nb-entry-writing button[aria-label="Delete AI question"]');
await wait("!document.querySelector('.nb-ai-exchange')");
// Inline AI is native notebook content and preserves sourced answers.
await evaluate("[...document.querySelectorAll('.nb-header-menu button')].find(b=>b.textContent.includes('Ask AI here')).click()");
await wait("!!document.querySelector('.nb-entry.is-editing .nb-ai-question')");
await fill('.nb-entry.is-editing .nb-ai-question','Explain how a qubit stores information');
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Ask').click()");
await wait("!!document.querySelector('.nb-entry.is-editing .nb-inline-answer .cite-chip')");
assert.ok(await evaluate("document.querySelector('.nb-inline-answer')?.textContent.includes('A qubit stores quantum information')"));
await evaluate("window.__inlineEntryId=document.querySelector('.nb-entry.is-editing').dataset.entryId");
// Reader edits survive completed regeneration until the new proposal is accepted.
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Edit answer').click()");
await wait("!!document.querySelector('[aria-label=\"Edit AI answer\"]')");
await fillRich('[aria-label="Edit AI answer"]','My edited explanation');
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Done editing').click()");
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Regenerate').click()");
await wait("[...document.querySelectorAll('.nb-proposal button')].some(b=>b.textContent==='Use new answer')");
assert.ok(await evaluate("document.querySelector('.nb-inline-answer').textContent.includes('My edited explanation')"),'regeneration retains the reader-edited current answer');
await evaluate("[...document.querySelectorAll('.nb-proposal button')].find(b=>b.textContent==='Keep current answer').click()");
assert.ok(await evaluate("document.querySelector('.nb-inline-answer').textContent.includes('My edited explanation')"));
// Interrupted exchanges can be retried and never rerun on reopen.
await evaluate('window.__holdAi=true');
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Regenerate').click()");
await wait("!!document.querySelector('.nb-ai-exchange.is-running')");
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Stop').click()");
await wait("!document.querySelector('.nb-ai-exchange.is-running')");
// Deleting an active generation aborts it; undo restores a stopped, editable box.
const requestsBeforeDelete = await evaluate('window.__nativeRequests.length');
await evaluate("[...document.querySelectorAll('.nb-entry.is-editing .nb-ai-actions button')].find(b=>b.textContent==='Regenerate').click()");
await wait(`!!document.querySelector('.nb-ai-exchange.is-running') && window.__nativeRequests.length>${requestsBeforeDelete}`);
const abortedBeforeDelete = await evaluate('window.__abortedAi || 0');
await click('.nb-entry.is-editing button[aria-label="Delete AI question"]');
await wait("!document.querySelector('.nb-ai-exchange')");
await wait(`window.__abortedAi>${abortedBeforeDelete}`);
await click('.nb-entry.is-editing button[aria-label="Undo"]');
await wait("!!document.querySelector('.nb-ai-exchange') && !document.querySelector('.nb-ai-exchange.is-running')");
await evaluate('window.__holdAi=false');
const beforeReopen=await evaluate('window.__nativeRequests.length');
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await click('.library-card-open');
await wait("!!document.querySelector('.native-reader') && !!document.querySelector('.nb-ai-exchange')");
assert.equal(await evaluate('window.__nativeRequests.length'),beforeReopen,'reopening never reruns AI');
assert.ok(await evaluate("document.querySelector('.nb-inline-answer').textContent.includes('My edited explanation')"),'edited answer survives reopening');
assert.ok(await evaluate("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'"));
assert.ok(await evaluate("document.querySelector('.notebook-dock').textContent.includes('A thought worth keeping while reading')"));
assert.ok(await evaluate("!!document.querySelector('.nb-entry-writing strong') && !!document.querySelector('.nb-entry-writing .katex') && !!document.querySelector('.nb-entry-writing table')"));
await evaluate("document.querySelector('.nb-entry-writing img')?.scrollIntoView({block:'center'})");
await send('Page.captureScreenshot',{format:'png'});
await wait("[...document.querySelectorAll('.nb-entry-writing img')].some(img=>img.naturalWidth===32)");
// Search and filters operate on the unified notebook.
await fill('input[aria-label="Search notebook"]','Remember');
await wait("document.querySelectorAll('.nb-entry').length===1");
await fill('input[aria-label="Search notebook"]','');
await evaluate("document.querySelector('select[aria-label=\"Filter notebook\"]').value='images';document.querySelector('select[aria-label=\"Filter notebook\"]').dispatchEvent(new Event('change',{bubbles:true}))");
await wait("document.querySelectorAll('.nb-entry').length===1");
await evaluate("document.querySelector('select[aria-label=\"Filter notebook\"]').value='all';document.querySelector('select[aria-label=\"Filter notebook\"]').dispatchEvent(new Event('change',{bubbles:true}))");
// Source glossary and Deep Dive remain available behind More.
await select('qubit');
await click('.dive-selection-tip button[aria-label="More selection actions"]');
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(b=>b.textContent==='Glossary').click()");
await wait("!!document.querySelector('.glossary-card') && !!document.querySelector('.flow-mark--glossary')");
await click('.flow-pane');
await select('qubit');
await click('.dive-selection-tip button[aria-label="More selection actions"]');
await click('.dive-selection-tip button[title="Dive deeper"]');
await wait("!!document.querySelector('.ask-turn-assistant .cite-chip')");
await click('.ask-turn-assistant .cite-chip');
await wait("!!document.querySelector('.flow-mark--flash')");
assert.ok(await evaluate("!document.querySelector('.notebook-dock').hidden"));
// Save selected AI text with its exact conversation/turn and sources.
await evaluate(`(() => {const answer=document.querySelector('.ask-turn-assistant .answer-markdown');const range=document.createRange();range.selectNodeContents(answer);window.getSelection().removeAllRanges();window.getSelection().addRange(range);answer.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
await wait("!!document.querySelector('.dive-selection-tip')");
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(b=>b.textContent==='Add to notebook').click()");
await wait("document.querySelector('.notice-host')?.textContent.includes('Added to notebook')");
const loadedPdf=requests.filter(url=>/PdfReader|pdfjs-dist|react-pdf-highlighter|html2canvas|\/assets\/(pdf[._-]|pdf_viewer-|convert-|Literata_)/.test(url));
assert.deepEqual(loadedPdf,[],'native notebook must not load PDF modules');
if(process.env.SCREENSHOT_PATH) {const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.SCREENSHOT_PATH,Buffer.from(screenshot.data,'base64'));}
// PDF legacy migration, notebook parity, source editing, and persistent Deep Dive.
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
const pdf=await PDFDocument.create();pdf.setTitle('PDF Regression');
const font=await pdf.embedFont(StandardFonts.Helvetica);
for(let page=1;page<=3;page++) pdf.addPage([400,600]).drawText(page===1?'PDF smoke test':`PDF page ${page}`,{x:40,y:550,size:18,font});
await upload(Array.from(await pdf.save()),'Regression.pdf','application/pdf');
await wait("!!document.querySelector('.PdfHighlighter .page[data-page-number=\"1\"]')");
await click('button[aria-label="Library"]');await wait("!!document.querySelector('.library')");
await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('knowbelreader');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const docs=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result)});const meta=docs.find(doc=>doc.fileName==='Regression.pdf');const tx=db.transaction('docData','readwrite');tx.objectStore('docData').delete(meta.docId+'/notebook');tx.objectStore('docData').put([{id:'pdf-test-highlight',type:'text',content:{text:'PDF smoke test'},comment:'PDF saved note',highlightColor:'#ffe08a',position:{boundingRect:{x1:40,y1:32,x2:180,y2:55,width:400,height:600,pageNumber:1},rects:[{x1:40,y1:32,x2:180,y2:55,width:400,height:600,pageNumber:1}],usePdfCoordinates:false}}],meta.docId+'/highlights');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();})()`);
await evaluate("[...document.querySelectorAll('.library-card-open')].find(b=>b.textContent.includes('PDF Regression')).click()");
await wait("document.querySelector('.notebook-dock')?.textContent.includes('PDF saved note')");
await click('.highlight-anchor[data-highlight-id="pdf-test-highlight"] .TextHighlight__part');
await wait("!!document.querySelector('.highlight-toolbar .TextHighlight__comment-button')");
await click('.highlight-toolbar .TextHighlight__comment-button');
await wait("!!document.querySelector('.nb-entry.is-editing .nb-rich-editor')");
await fillRich('.nb-entry.is-editing .nb-rich-editor','Edited PDF note');
await click('.nb-entry.is-editing .nb-editor-footer button');
await click('.highlight-anchor[data-highlight-id="pdf-test-highlight"] .TextHighlight__part');
await wait("!!document.querySelector('.highlight-toolbar button[aria-label=\"More selection actions\"]')");
await click('.highlight-toolbar button[aria-label="More selection actions"]');
await click('.highlight-toolbar button[title="Dive deeper"]');
await wait("!!document.querySelector('.dive-panel-pane')");
assert.ok(await evaluate("!document.querySelector('.notebook-dock').hidden && document.querySelector('.notebook-dock').textContent.includes('Edited PDF note')"),'notebook stays available in Deep Dive');
// Return to native reading with all notebook content intact.
await upload(source);await wait("!!document.querySelector('.native-reader')");
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
await click('button[aria-label="Library"]');await wait("!!document.querySelector('.library')");
// Large inputs must take the worker path, and restore a distant location.
await evaluate("window.__workers=0;window.__workerResults=0;window.__longTasks=[];const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);window.__workers++;this.addEventListener('message',()=>window.__workerResults++);}};new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask'});");
const longSource='# Long Native\n\n'+Array.from({length:3500},(_,i)=>`Paragraph ${i}: Native reading preserves precise text anchors while allowing the document to reflow. No geometry is stored for these passages.\n`).join('\n')+'\n## End\n\nEnd content for reading restoration.';
const start=Date.now();
await upload(longSource,'Long.md');
await wait("document.querySelectorAll('.flow-block').length===3503");
const openMs=Date.now()-start;
assert.ok(await evaluate('window.__workers>0'),'large Markdown parses in a worker');
assert.ok(await evaluate('window.__workerResults>0'),'the worker completed parsing');
await click('button[aria-label="Table of contents"]');
await evaluate("[...document.querySelectorAll('.flow-contents button')].find(button=>button.textContent==='End').click()");
await wait("document.querySelector('.flow-scroll').scrollTop>10000");
await new Promise(resolve=>setTimeout(resolve,100));
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await wait("[...document.querySelectorAll('.library-card-open')].some(button=>button.textContent.includes('Long Native'))");
// A large, mixed rich notebook must remain cheap next to a large source.
await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('knowbelreader');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const docs=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result)});const meta=docs.find(doc=>doc.fileName==='Long.md');const tx=db.transaction('docData','readwrite');tx.objectStore('docData').put({schemaVersion:1,docId:meta.docId,revision:1,migrated:true,sections:[{id:'document',title:'Document notes'}],captures:[],entries:Array.from({length:1000},(_,i)=>({id:'perf-note-'+i,sectionId:'document',captureIds:[],createdAt:'2026-11-05',updatedAt:'2026-11-05',body:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Technical observation '+i+': preserve the source and reasoning.',marks:[{type:'bold'}]}]},{type:'blockMath',attrs:{latex:'E=mc^2'}},{type:'aiExchange',attrs:{id:'perf-q-'+i,question:'What follows?',answer:'A saved explanation.',status:'complete',sources:[]}}]}}))},meta.docId+'/notebook');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()})()`);

await evaluate("[...document.querySelectorAll('.library-card-open')].find(button=>button.textContent.includes('Long Native')).click()");
await wait("document.querySelector('.flow-scroll')?.scrollTop>10000");
const maxMainThreadTaskMs=Math.round(await evaluate('Math.max(0,...window.__longTasks)'));
const notebookStart=Date.now();
if(await evaluate("document.querySelector('.notebook-dock').hidden")) await click('button[aria-label="Notebook"]');
await wait("document.querySelectorAll('.nb-entry-shell').length===1000");
await wait("document.querySelectorAll('.nb-entry').length>0");
const renderedNotes=await evaluate("document.querySelectorAll('.nb-entry').length");
assert.ok(renderedNotes<40,`expected lazy rich rendering, rendered ${renderedNotes} of 1000 notes`);
await click('.nb-entry-writing');
await wait("document.querySelectorAll('.nb-rich-editor').length===1");
await evaluate("const paragraph=document.querySelector('.nb-rich-editor p');const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(range);document.querySelector('.nb-rich-editor').focus()");
await evaluate("window.__sourceMutations=0;window.__notebookTypingTasks=[];new MutationObserver(list=>window.__sourceMutations+=list.length).observe(document.querySelector('.flow-document'),{childList:true,subtree:true,characterData:true,attributes:true});window.__longTasks=[]");
await send('Input.insertText',{text:' Performance thought'});
await wait("document.querySelector('.nb-save-state').textContent.includes('Saved')");
assert.equal(await evaluate('window.__sourceMutations'),0,'notebook typing does not mutate the source, even with 1000 rich notes');
const notebookOpenMs=Date.now()-notebookStart;
const notebookTypingMaxTaskMs=Math.round(await evaluate('Math.max(0,...window.__longTasks)'));
await click('button[aria-label="Library"]');await wait("!!document.querySelector('.library')");
await evaluate("[...document.querySelectorAll('.library-card-open')].find(button=>button.textContent.includes('Long Native')).click()");
await wait("document.querySelector('.nb-rich-editor')?.textContent.includes('Performance thought')");
assert.equal(await evaluate("document.querySelector('.nb-entry.is-editing')?.dataset.entryId"),'perf-note-0','the active writing place is restored');
await send('Input.insertText',{text:' continued'});
assert.ok(await evaluate("document.querySelector('.nb-rich-editor').textContent.includes('Performance thought continued')"),'caret returns to its saved position');
await send('Emulation.setDeviceMetricsOverride',{width:600,height:850,deviceScaleFactor:1,mobile:false});
assert.ok(await evaluate("document.querySelector('.notebook-dock').getBoundingClientRect().width<=600"),'narrow notebook fits the viewport');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});


// Packaged webviews that disallow module workers still read the same files.
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await evaluate("window.Worker=class{constructor(){throw new DOMException('Workers are unavailable','SecurityError');}}");
await upload(longSource+'\n\nFallback marker.','Fallback.md');
await wait("document.querySelectorAll('.flow-block').length===3504");
assert.ok(await evaluate("document.querySelector('.flow-document').textContent.includes('Fallback marker.')"));
assert.deepEqual(errors,[],'No browser runtime errors, including PDF/native switching');
assert.deepEqual(consoleErrors,[],'No browser console errors');
console.log(JSON.stringify({passed:true,pdfModulesDuringMarkdown:loadedPdf.length,largeDocument:{blocks:3503,openMs,maxMainThreadTaskMs},largeNotebook:{entries:1000,renderedNotes,openAndSaveMs:notebookOpenMs,typingMaxTaskMs:notebookTypingMaxTaskMs},apiCalls:await evaluate('window.__nativeRequests.map(request=>request.url)')}));
} catch(error) { console.error(JSON.stringify({runtimeErrors:errors,consoleErrors,visibility:await evaluate("document.visibilityState"),images:await evaluate("[...document.querySelectorAll('.nb-entry-writing img')].map(img=>({src:img.src,width:img.naturalWidth,loading:img.loading,complete:img.complete}))"),editor:await evaluate("document.querySelector('.nb-rich-editor')?.outerHTML"),notices:await evaluate("document.querySelector('.notice-host')?.textContent")})); const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/private/tmp/knowbel-notebook-failure.png',Buffer.from(shot.data,'base64')); throw error; } finally { await send('Target.disposeBrowserContext',{browserContextId}); ws.close(); }
