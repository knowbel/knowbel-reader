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
async function saveNote(selector) {
  await evaluate(`(() => {const editor=document.querySelector(${JSON.stringify(selector)});[...editor.querySelectorAll('button')].find(button=>button.textContent==='Save').click();})()`);
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
await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
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
await evaluate(`window.__annotationUi = () => {
  const button = (element) => [element.textContent.trim(),element.getAttribute('aria-label'),element.getAttribute('title'),element.className];
  const style = (selector) => {const value=getComputedStyle(document.querySelector(selector));return [value.width,value.padding,value.fontSize,value.color,value.backgroundColor,value.borderRadius];};
  return {
    collapse: document.querySelector('.sidebar-collapse-button').outerHTML,
    toolbar: [...document.querySelectorAll('.annot-toolbar button')].map(button),
    sort: [...document.querySelector('select[aria-label="Sort annotations"]').options].map(option=>[option.value,option.textContent]),
    actions: [...document.querySelectorAll('.annot-card--highlight button')].map(button),
    styles: ['.sidebar-panel','.annot-header','.annot-card--highlight','.annot-card-actions','.annot-sort'].map(style),
  };
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
await select('Repeat target',1);
await click('.dive-selection-tip .TextHighlight__color-row-item');
await wait("!!document.querySelector('.flow-mark')");
assert.equal(await evaluate("document.querySelector('.flow-mark').textContent"),'Repeat target');
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'+',code:'Equal',modifiers:4});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'+',code:'Equal',modifiers:4});
await wait("document.querySelector('.flow-document').style.fontSize==='110%'");
await evaluate("document.querySelector('.flow-document p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
await wait("!!document.querySelector('.annot-card--sticky .annot-editor-textarea')");
assert.equal(await evaluate("document.querySelector('.annot-card--sticky .annot-editor-textarea').value"), '', 'new sticky editor starts empty');
assert.ok(await evaluate("document.activeElement===document.querySelector('.annot-card--sticky .annot-editor-textarea')"));
await fill('.annot-card--sticky .annot-editor-textarea','Remember this passage');
await saveNote('.annot-card--sticky .annot-editor');
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
// Native annotations use the same cards, search, filters, editors and export as PDF.
await wait("!!document.querySelector('.annot-header input[aria-label=\"Search annotations\"]')");
assert.equal(await evaluate("document.querySelector('select[aria-label=\"Sort annotations\"]').selectedOptions[0].textContent"),'By location');
await click('.annot-card--highlight button[aria-label="Add note"]');
await fill('.annot-card--highlight .annot-editor-textarea','Shared highlight note');
await saveNote('.annot-card--highlight .annot-editor');
await wait("document.querySelector('.annot-card--highlight .annot-card-comment')?.textContent.includes('Shared highlight note')");
await click('.annot-card--highlight .annot-card-body');
await wait("!!document.querySelector('.flow-mark--flash')");
await click('.annot-new-note');
await fill('.annot-composer .annot-editor-textarea','Shared document note');
await saveNote('.annot-composer .annot-editor');
await wait("document.querySelector('.annot-card--note')?.textContent.includes('Shared document note')");
await fill('input[aria-label="Search annotations"]','Remember');
await wait("document.querySelectorAll('.annot-card').length===1 && !!document.querySelector('.annot-card--sticky')");
await fill('input[aria-label="Search annotations"]','');
await click('.annot-filters > button');
await evaluate("[...document.querySelectorAll('.annot-filters-item')].find(label=>label.textContent.includes('Sticky notes')).querySelector('input').click()");
await wait("document.querySelectorAll('.annot-card').length===1 && !!document.querySelector('.annot-card--sticky')");
await click('.annot-filters > button');
await click('.annot-chips-clear');
await wait("document.querySelectorAll('.annot-card').length===3");
await evaluate("const sort=document.querySelector('select[aria-label=\"Sort annotations\"]');sort.value='recent';sort.dispatchEvent(new Event('change',{bubbles:true}));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.__copiedAnnotations=text;}}})");
await click('button[aria-label="Copy shown annotations as Markdown"]');
await wait("window.__copiedAnnotations?.includes('Shared document note')");
assert.ok(await evaluate("window.__copiedAnnotations.includes('Remember this passage') && window.__copiedAnnotations.includes('Shared highlight note') && !window.__copiedAnnotations.includes('p. ')") , 'native export uses section labels');
await click('.annot-card--highlight button[aria-label="Delete"]');
await wait("!document.querySelector('.annot-card--highlight')");
await click('.flow-pane');
await evaluate('document.activeElement?.blur()');
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:4});
await wait("!!document.querySelector('.annot-card--highlight')");
await evaluate("window.getSelection().removeAllRanges();document.querySelector('.flow-document table td').click()");
await wait("!!document.querySelector('.dive-selection-tip')");
await click('.dive-selection-tip .TextHighlight__color-row-item');
await wait("!!document.querySelector('.flow-object-mark')");
await click('button[aria-label="Search (⌘F)"]');
await evaluate("document.querySelector('input[aria-label=\"Search document\"]').focus()");
await send('Input.insertText',{text:'qubit'});
await wait("document.querySelectorAll('.flow-results button').length===2");
await click('.flow-results button');
await select('qubit');
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(button=>button.textContent==='Glossary').click()");
await wait("!!document.querySelector('.glossary-card')");
await wait("!!document.querySelector('.flow-mark--glossary')");
await wait("document.querySelector('.glossary-card')?.textContent.includes('A quantum bit stores quantum information.')");
await click('.flow-pane');
await select('qubit');
await evaluate("document.querySelector('.dive-selection-tip button[title*=Dive],.dive-selection-tip .dive-control button')?.click()");
// Select the actual Deep Dive control using its accessible tooltip if its class changes.
if(!await evaluate("window.__nativeRequests.some(request=>request.url.includes('/dive/'))")) {
  await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(button=>(button.title+' '+button.textContent).toLowerCase().includes('dive'))?.click()");
}
await wait("window.__nativeRequests.some(request=>request.url.includes('/dive/'))");
await wait("!!document.querySelector('.ask-turn-assistant .cite-chip')");
assert.ok((await evaluate("document.querySelector('.cite-chip').dataset.label")).includes('Native Study'));
assert.ok(!/^p\./.test(await evaluate("document.querySelector('.cite-chip').dataset.label")));
await click('.cite-chip');
await wait("!!document.querySelector('.flow-mark--flash')");
await wait("!document.querySelector('button[aria-label^=\"Back to \"]').disabled");
await click('.page-nav button[aria-label^="Back to "]');
await wait("!document.querySelector('button[aria-label^=\"Forward to \"]').disabled");
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await click('.library-card-open');
await wait("!!document.querySelector('.native-reader')");
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
assert.equal(await evaluate("document.querySelectorAll('.flow-mark:not(.flow-mark--glossary):not(.flow-mark--flash)').length"),5);
await click('button[aria-label="Annotations"]');
await wait("!!document.querySelector('.annot-card--note')");
assert.ok(await evaluate("document.querySelector('.annot-card--highlight .annot-card-comment')?.textContent.includes('Shared highlight note')"));
assert.ok(await evaluate("document.querySelector('.annot-card--note').textContent.includes('Shared document note')"));
const nativePanelUi = await evaluate('window.__annotationUi()');
await evaluate("document.querySelector('.annot-card--highlight').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
await wait("getComputedStyle(document.querySelector('.flow-mark[data-annotation-id]')).boxShadow!=='none'");
await evaluate("document.querySelector('.annot-card--highlight').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
await wait("getComputedStyle(document.querySelector('.flow-mark[data-annotation-id]')).boxShadow==='none'");
// No badge without an associated conversation. Start a dive from the document tooltip.
const nativeDiveCalls = await evaluate("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length");
assert.equal(await evaluate("document.querySelectorAll('.annot-dive-link').length"),0);
await evaluate("window.getSelection().removeAllRanges();document.querySelector('.flow-mark[data-annotation-id]').click()");
await wait("!!document.querySelector('.dive-selection-tip')");
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(button=>(button.title+' '+button.textContent).toLowerCase().includes('dive')).click()");
await wait("!!document.querySelector('.ask-turn-assistant .cite-chip')");
await wait("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length>"+nativeDiveCalls);
await click('button[aria-label="Annotations"]');
await wait("!!document.querySelector('.annot-card--highlight .annot-dive-link')");
assert.equal(await evaluate("document.querySelectorAll('.annot-dive-link').length"),1);
await click('.annot-card--highlight .annot-dive-link');
await wait("!!document.querySelector('.ask-turn-assistant .cite-chip')");
assert.equal(await evaluate("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length"),nativeDiveCalls+1);
await click('button[aria-label="Annotations"]');
await wait("!!document.querySelector('.annot-card--highlight')");
const loadedPdf = requests.filter(url=>/PdfReader|pdfjs-dist|react-pdf-highlighter|html2canvas|\/assets\/(pdf[._-]|pdf_viewer-|convert-|Literata_)/.test(url));
assert.deepEqual(loadedPdf,[],'Markdown should not load PDF modules');
assert.deepEqual(errors,[],'No browser runtime errors');
if(process.env.SCREENSHOT_PATH) {const screenshot=await send('Page.captureScreenshot',{format:'png'});
await writeFile(process.env.SCREENSHOT_PATH,Buffer.from(screenshot.data,'base64'));}

// Exercise an actual image attachment, including an image without alt text.
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
const png=await evaluate("(() => {const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,16,16);return canvas.toDataURL('image/png');})()");
await upload('# Image document\n\n![]('+png+')','Image.md');
await wait("!!document.querySelector('.flow-image img')");
await click('.flow-image img');
await wait("!!document.querySelector('.dive-selection-tip')");
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(button=>(button.title+' '+button.textContent).toLowerCase().includes('dive')).click()");
await wait("window.__nativeRequests.some(request=>request.body.messages?.some(message=>message.images?.length))");
assert.equal(await evaluate("window.__nativeRequests.at(-1).body.messages.at(-1).images[0].mediaType"),'image/jpeg');

// Switch through the unchanged PDF reader, then reopen the original notes.
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
const pdf=await PDFDocument.create();pdf.setTitle('PDF Regression');
const font=await pdf.embedFont(StandardFonts.Helvetica);
for(let page=1;page<=3;page++) pdf.addPage([400,600]).drawText(page===1?'PDF smoke test':`PDF page ${page}`,{x:40,y:550,size:18,font});
await upload(Array.from(await pdf.save()),'Regression.pdf','application/pdf');
await wait("!!document.querySelector('.PdfHighlighter .page[data-page-number=\"1\"]')");
assert.deepEqual(await evaluate('window.__navigatorStyle()'),nativeNavigationUi,'PDF and Markdown share navigator positioning and appearance');
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'g',code:'KeyG',modifiers:5});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'g',code:'KeyG',modifiers:5});
await wait("document.activeElement===document.querySelector('.page-nav-input')");
await send('Input.insertText',{text:'2'});
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});
await wait("document.querySelector('.page-nav-input').value==='2'");
await click('.page-nav button[aria-label="Next page"]');
await wait("document.querySelector('.page-nav-input').value==='3'");
await click('.page-nav button[aria-label="Previous page"]');
await wait("document.querySelector('.page-nav-input').value==='2'");
await click('.page-nav button[aria-label^="Back to p. 1"]');
await wait("document.querySelector('.page-nav-input').value==='1'");

await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await evaluate(`(async () => {
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('knowbelreader');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const docs=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result);});
  const meta=docs.find(doc=>doc.fileName==='Regression.pdf');
  const tx=db.transaction('docData','readwrite');
  tx.objectStore('docData').put([{id:'pdf-test-highlight',type:'text',content:{text:'PDF smoke test'},comment:'PDF saved note',highlightColor:'#ffe08a',position:{boundingRect:{x1:40,y1:32,x2:180,y2:55,width:400,height:600,pageNumber:1},rects:[{x1:40,y1:32,x2:180,y2:55,width:400,height:600,pageNumber:1}],usePdfCoordinates:false}}],meta.docId+'/highlights');
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
})()`);
await evaluate("[...document.querySelectorAll('.library-card-open')].find(button=>button.textContent.includes('PDF Regression')).click()");
await wait("!!document.querySelector('.PdfHighlighter .page[data-page-number=\"1\"]')");
await click('button[aria-label="Annotations"]');
await wait("!!document.querySelector('.annot-card--highlight')");
assert.equal(await evaluate("document.querySelector('select[aria-label=\"Sort annotations\"]').selectedOptions[0].textContent"),'By location');
assert.ok(await evaluate("document.querySelector('.annot-card--highlight').textContent.includes('PDF saved note') && document.querySelector('.annot-group-heading').textContent.includes('Page 1')"));
assert.deepEqual(await evaluate('window.__annotationUi()'),nativePanelUi,'PDF and Markdown share panel/frame/card controls and computed styling');
await click('.annot-card--highlight button[aria-label="Edit note"]');
await fill('.annot-card--highlight .annot-editor-textarea','Edited PDF note');
await saveNote('.annot-card--highlight .annot-editor');
await wait("document.querySelector('.annot-card--highlight .annot-card-comment')?.textContent.includes('Edited PDF note')");
await click('.annot-card--highlight .annot-card-body');
const pdfDiveCalls = await evaluate("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length");
assert.equal(await evaluate("document.querySelectorAll('.annot-dive-link').length"),0);
await click('.highlight-anchor[data-highlight-id="pdf-test-highlight"] .TextHighlight__part');
await wait("!!document.querySelector('.highlight-toolbar button[title=\"Dive deeper\"]')");
await click('.highlight-toolbar button[title="Dive deeper"]');
await wait("!!document.querySelector('.dive-panel-pane')");
await wait("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length>"+pdfDiveCalls);
await wait("document.querySelector('.dive-panel-pane')?.textContent.includes('A qubit stores quantum information')");
// Return to the document workspace and open the same linked dive again.
await evaluate("document.querySelector('.app-rail button[aria-label=\"Annotations\"]')?.click()");
// The shared annotations control returns from the dive to the document panel.
await wait("!!document.querySelector('.annot-card--highlight .annot-dive-link')");
assert.equal(await evaluate("document.querySelectorAll('.annot-dive-link').length"),1);
await click('.annot-card--highlight .annot-dive-link');
assert.equal(await evaluate("window.__nativeRequests.filter(request=>request.url.includes('/dive/')).length"),pdfDiveCalls+1);
await upload(source);
await wait("!!document.querySelector('.native-reader')");
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");

// Leaving a document cancels a pending reply, settles it and flushes notes.
await evaluate('window.__holdAi=true');
await select('Use');
await evaluate("[...document.querySelectorAll('.dive-selection-tip button')].find(button=>(button.title+' '+button.textContent).toLowerCase().includes('dive')).click()");
await wait("document.querySelector('.ask-turn-assistant')?.textContent.includes('Reading')");
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
assert.equal(await evaluate('window.__abortedAi'),1);
await evaluate('window.__holdAi=false');

// Large inputs must take the worker path, and restore a distant location.
await evaluate("window.__workers=0;window.__workerResults=0;window.__longTasks=[];const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);window.__workers++;this.addEventListener('message',()=>window.__workerResults++);}};new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask'});");
const longSource='# Long Native\n\n'+Array.from({length:3500},(_,i)=>`Paragraph ${i}: Native reading preserves precise text anchors while allowing the document to reflow. No geometry is stored for these passages.\n`).join('\n')+'\n## End\n\nEnd content for reading restoration.';
const start=Date.now();
await upload(longSource,'Long.md');
await wait("document.querySelectorAll('.flow-block').length===3503");
const openMs=Date.now()-start;
assert.ok(await evaluate('window.__workers>0'),'large Markdown parses in a worker');
assert.ok(await evaluate('window.__workerResults>0'),'the worker completed parsing');
await evaluate("[...document.querySelectorAll('.flow-contents button')].find(button=>button.textContent==='End').click()");
await wait("document.querySelector('.flow-scroll').scrollTop>10000");
await new Promise(resolve=>setTimeout(resolve,100));
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await wait("[...document.querySelectorAll('.library-card-open')].some(button=>button.textContent.includes('Long Native'))");
await evaluate("[...document.querySelectorAll('.library-card-open')].find(button=>button.textContent.includes('Long Native')).click()");
await wait("document.querySelector('.flow-scroll')?.scrollTop>10000");
const maxMainThreadTaskMs=Math.round(await evaluate('Math.max(0,...window.__longTasks)'));

// Packaged webviews that disallow module workers still read the same files.
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await evaluate("window.Worker=class{constructor(){throw new DOMException('Workers are unavailable','SecurityError');}}");
await upload(longSource+'\n\nFallback marker.','Fallback.md');
await wait("document.querySelectorAll('.flow-block').length===3504");
assert.ok(await evaluate("document.querySelector('.flow-document').textContent.includes('Fallback marker.')"));
assert.deepEqual(errors,[],'No browser runtime errors, including PDF/native switching');
assert.deepEqual(consoleErrors,[],'No browser console errors');
console.log(JSON.stringify({passed:true,pdfModulesDuringMarkdown:loadedPdf.length,largeDocument:{blocks:3503,openMs,maxMainThreadTaskMs},apiCalls:await evaluate('window.__nativeRequests.map(request=>request.url)')}));
} finally { await send('Target.disposeBrowserContext',{browserContextId}); ws.close(); }
