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
const source='# Native Study\n\nA qubit stores quantum information. Repeat target appears here. Repeat target appears again.\n\nUse **formatted** text and $E=mc^2$ in a passage.\n\n## Methods\n\n- [x] Done\n- [ ] Pending\n\n| Epoch | Loss |\n| --- | --- |\n| 1 | 0.2 |\n\n![Training curve](figures/curve.png)\n\n[Jump to results](#results)\n\n## Results\n\nThe experiment measures a qubit.\n\n'+Array.from({length:30},(_,i)=>`Paragraph ${i}: Read the surrounding explanation and preserve annotations across layout changes.\n`).join('\n');
await upload(source);
await wait("!!document.querySelector('.native-reader .flow-document h1')");
assert.equal(await evaluate("document.querySelector('.flow-document h1').textContent"),'Native Study');
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
await wait("!!document.querySelector('textarea[aria-label=\"Sticky note text\"]')");
await evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Sticky note text"]');field.focus();field.value='Remember this passage';field.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
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
await click('.flow-header');
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
await wait("!document.querySelector('button[aria-label=\"Back\"]').disabled");
await click('button[aria-label="Back"]');
await wait("!document.querySelector('button[aria-label=\"Forward\"]').disabled");
await click('button[aria-label="Library"]');
await wait("!!document.querySelector('.library')");
await click('.library-card-open');
await wait("!!document.querySelector('.native-reader')");
await wait("document.querySelector('.flow-sticker')?.textContent==='Remember this passage'");
assert.equal(await evaluate("document.querySelectorAll('.flow-mark:not(.flow-mark--glossary):not(.flow-mark--flash)').length"),5);
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
pdf.addPage([400,600]).drawText('PDF smoke test',{x:40,y:550,size:18,font});
await upload(Array.from(await pdf.save()),'Regression.pdf','application/pdf');
await wait("!!document.querySelector('.PdfHighlighter .page[data-page-number=\"1\"]')");
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
