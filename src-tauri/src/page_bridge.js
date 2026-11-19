(() => {
  if (window.top !== window || window.__knowbelPage) return;
  // Taken before the site's scripts run, which may wrap fetch.
  const nativeFetch = window.fetch.bind(window);
  // Requests in flight, for telling when the page has settled (see below).
  let inflight = 0, activity = Date.now();
  const touch = () => { activity = Date.now(); };
  const end = () => { inflight--; touch(); };
  window.fetch = function fetch(...args) {
    inflight++; touch();
    const request = nativeFetch(...args); request.then(end, end); return request;
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    inflight++; touch(); this.addEventListener('loadend', end, { once: true });
    try { return send.apply(this, args); } catch (error) { this.removeEventListener('loadend', end); end(); throw error; }
  };
  // Actions the reader accepts from this page. Only trusted (user) events
  // queue them, so page scripts cannot start notes, questions or dives.
  const allowed = new Set(['highlight','pen','note','open-note','ask','dive','open-dive','glossary','delete','pin','key']);
  // Mirrors highlightColors.ts and HighlightToolbar so a live page offers the
  // same selection controls as every other document.
  const presets = [['rgba(255, 226, 143, 1)','Yellow'],['#ffcdd2','Red'],['#c8e6c9','Green'],['#bbdefb','Blue'],['#e1bee7','Purple']];
  const icons = {
    copy:[['rect',{width:14,height:14,x:8,y:8,rx:2,ry:2}],['path',{d:'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]],
    check:[['path',{d:'M20 6 9 17l-5-5'}]],
    ask:[['path',{d:'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'}],['path',{d:'M12 8v6'}],['path',{d:'M9 11h6'}]],
    trash:[['path',{d:'M10 11v6'}],['path',{d:'M14 11v6'}],['path',{d:'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'}],['path',{d:'M3 6h18'}],['path',{d:'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'}]],
    highlight:[['path',{d:'m9 11-6 6v3h9l3-3'}],['path',{d:'m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4'}]],
    underline:[['path',{d:'M6 4v6a6 6 0 0 0 12 0V4'}],['line',{x1:4,x2:20,y1:20,y2:20}]],
    strikethrough:[['path',{d:'M16 4H9a3 3 0 0 0-2.83 4'}],['path',{d:'M14 12a4 4 0 0 1 0 8H6'}],['line',{x1:4,x2:20,y1:12,y2:12}]],
  };
  const toolbarCss = `:host{all:initial;position:fixed;z-index:2147483647;font:600 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.toolbar{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:max-content;max-width:min(480px,calc(100vw - 20px))}
.row,.colors{display:flex;align-items:center;gap:6px;padding:4px 6px;background:#1c1b18;border-radius:9px;box-shadow:0 8px 24px -6px rgba(28,27,24,.22);white-space:nowrap;max-width:100%;overflow-x:auto}
.colors{padding:6px 8px}
.more{display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:100%;padding-top:2px}
.row>button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:28px;height:28px;margin:0;padding:0 8px;border:0;border-radius:6px;background:transparent;color:#efece5;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer;transition:background .15s,color .15s}
.row>button:hover:not(:disabled){background:rgba(255,255,255,.14);color:#fff}
.row>button.delete:hover{background:rgba(239,68,68,.24);color:#ff8a80}
.row>button:disabled{color:rgba(239,236,229,.5);cursor:default}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.style{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:#efece5;cursor:pointer}
.style:hover{background:rgba(255,255,255,.14);color:#fff}.style.active{background:#5b50e6;color:#fff}
.divider{width:1px;height:18px;background:rgba(255,255,255,.2)}
.swatch{display:flex;padding:0;border:0;background:transparent;cursor:pointer}
.swatch span{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(255,255,255,.5);color:#1c1b18;transition:transform .1s}
.swatch:hover span{transform:scale(1.12)}
svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.style svg{width:16px;height:16px}.swatch svg{width:12px;height:12px;stroke-width:3}`;
  let cached = null, pending = [], config = {tool:'select',color:presets[0][0],style:'highlight'}, marks = [], requested = [];
  let host, shadow, expanded = false, fresh = 'highlight', copied = false, index = null, repaint, retries = 0, flashTimer;
  const ui = node => node instanceof Element && !!node.closest('[data-knowbel-ui]');
  const safeRange = range => range && range.startContainer.isConnected && range.endContainer.isConnected;
  const sheet = (() => { try { return new CSSStyleSheet(); } catch { return null; } })();
  // Constructed sheets are not blocked by a site's inline-style policy.
  const adopt = () => { if (sheet && !document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; };
  const cache = (range, annotationId) => {
    if (!safeRange(range)) return null;
    const text = range.toString().trim();
    if (!text || text.length > 16000) return null;
    cached = {range:range.cloneRange(),text,annotationId,url:location.href};
    return cached;
  };
  const read = () => {
    const selected = getSelection();
    if (!cached && selected?.rangeCount && !selected.isCollapsed) cache(selected.getRangeAt(0));
    if (!cached || !safeRange(cached.range)) return {text:'',prefix:'',suffix:'',url:location.href,scrollY};
    const range=cached.range, before=range.cloneRange(), after=range.cloneRange();
    before.selectNodeContents(document.body);before.setEnd(range.startContainer,range.startOffset);
    after.selectNodeContents(document.body);after.setStart(range.endContainer,range.endOffset);
    const rect=range.getBoundingClientRect();
    return {text:cached.text,prefix:before.toString().slice(-120),suffix:after.toString().slice(0,120),
      annotationId:cached.annotationId,url:cached.url,scrollY,
      rect:{left:rect.left,top:rect.top,bottom:rect.bottom}};
  };
  const notify = (action, event, extra={}) => {
    if (!event.isTrusted || !allowed.has(action)) return;
    pending.push({...read(),action,...extra});if(pending.length>8)pending.shift();
    location.href='https://knowbel.invalid/__reader_event';
  };
  // The page has settled once it has loaded, its fonts are ready, no requests
  // or eager images are pending, and nothing else finished loading for a
  // second. Pages that never go quiet (polling, streams) report after 30
  // seconds. Reported once per document, so the reader can save the page as
  // soon as it is complete. Not a user action, so no trusted event is needed.
  try { new PerformanceObserver(touch).observe({type:'resource',buffered:true}); } catch { /* Requests are still tracked */ }
  addEventListener('load',touch);
  const started = Date.now();
  const settle = setInterval(() => {
    const loaded=document.readyState==='complete', capped=Date.now()-started>=30000&&document.readyState!=='loading';
    const busy=inflight>0||document.fonts?.status==='loading'||[...document.images].some(image=>!image.complete&&image.loading!=='lazy');
    if(!(loaded&&!busy&&Date.now()-activity>=1000)&&!capped)return;
    clearInterval(settle);
    pending.push({action:'settled',text:'',prefix:'',suffix:'',url:location.href,scrollY});if(pending.length>8)pending.shift();
    location.href='https://knowbel.invalid/__reader_event';
  },250);
  const hide = () => { if(host)host.hidden=true; expanded=false; copied=false; };
  const done = () => { hide(); cached=null; getSelection()?.removeAllRanges(); };
  const svg = name => {
    const root=document.createElementNS('http://www.w3.org/2000/svg','svg');root.setAttribute('viewBox','0 0 24 24');
    for(const [tag,attributes] of icons[name]){const child=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes))child.setAttribute(key,String(value));root.append(child);}
    return root;
  };
  const control = (className, title, content, onClick) => {
    const b=document.createElement('button');b.type='button';if(className)b.className=className;if(title)b.title=title;
    b.append(...content);
    b.addEventListener('mousedown',event=>event.preventDefault());
    b.addEventListener('click',event=>{event.stopPropagation();if(event.isTrusted)onClick(event);});
    return b;
  };
  const glossaryReason = text => {
    const term=text.replace(/\s+/g,' ').trim().replace(/^[\s"'([{<.,;:!?*]+|[\s"')\]}>.,;:!?*]+$/g,'');
    return term && term.length<=80 && term.split(' ').length<=8 ? '' : 'Select a term of up to eight words';
  };
  const place = () => {
    if(!host||host.hidden||!cached)return;
    if(!safeRange(cached.range)){hide();return;}
    const r=cached.range.getBoundingClientRect();
    host.style.left=Math.max(8,Math.min(innerWidth-host.offsetWidth-8,r.left))+'px';
    const top=r.top-host.offsetHeight-8;host.style.top=Math.max(8,top>=8?top:Math.min(innerHeight-host.offsetHeight-8,r.bottom+8))+'px';
  };
  const show = () => {
    if (!cached) return;
    if(!host){
      host=document.createElement('div');host.dataset.knowbelUi='selection';
      shadow=host.attachShadow({mode:'closed'});
      try{const style=new CSSStyleSheet();style.replaceSync(toolbarCss);shadow.adoptedStyleSheets=[style];}catch{const style=document.createElement('style');style.textContent=toolbarCss;shadow.append(style);}
      document.documentElement.append(host);
    }
    const mark=marks.find(item=>item.id===cached.annotationId), sticker=mark?.kind==='sticker';
    const color=mark?.color??config.color, style=mark?.style??fresh;
    const box=document.createElement('div');box.className='toolbar';
    const row=document.createElement('div');row.className='row';
    const save=(change,close)=>event=>{notify('highlight',event,change);if(close)done();else{if(mark)Object.assign(mark,change);show();}};
    if(!sticker){const dot=document.createElement('span');dot.className='dot';dot.style.background=color;row.append(control('','Highlight selection',[dot,'Highlight'],save({color,style},true)));}
    row.append(control('','',['Note'],event=>{notify('open-note',event);done();}));
    row.append(control('','Ask about this selection',[svg('ask'),'Ask'],event=>{notify('ask',event);done();}));
    const toggle=control('','More selection actions',['•••'],()=>{expanded=!expanded;show();});toggle.setAttribute('aria-expanded',String(expanded));row.append(toggle);
    box.append(row);
    if(expanded){
      const more=document.createElement('div');more.className='more';
      const actions=document.createElement('div');actions.className='row';
      actions.append(control('',copied?'Copied':'Copy text',[svg(copied?'check':'copy'),'Copy'],()=>{void navigator.clipboard.writeText(cached.text).then(()=>{copied=true;show();},()=>{});}));
      actions.append(control('',mark?.diveId?'Open this dive':'Dive deeper',['Dive ↗'],event=>{notify(mark?.diveId?'open-dive':'dive',event);done();}));
      if(!mark)actions.append(control('','',['Add to notebook'],event=>{notify('pin',event);done();}));
      const reason=glossaryReason(cached.text), glossary=control('',reason||'Add to glossary',['Glossary'],event=>{notify('glossary',event);done();});glossary.disabled=!!reason;actions.append(glossary);
      if(mark)actions.append(control('delete','Remove highlight',[svg('trash')],event=>{notify('delete',event);done();}));
      more.append(actions);
      if(!sticker){
        const colors=document.createElement('div');colors.className='colors';
        for(const [name,title] of [['highlight','Highlight'],['underline','Underline'],['strikethrough','Strikethrough']])
          colors.append(control('style'+(style===name?' active':''),title,[svg(name)],event=>{if(mark){save({style:name},false)(event);}else{fresh=name;notify('pen',event,{style:name});show();}}));
        const divider=document.createElement('div');divider.className='divider';colors.append(divider);
        for(const [preset,title] of presets){const dot=document.createElement('span');dot.style.backgroundColor=preset;if(preset===color)dot.append(svg('check'));
          colors.append(control('swatch',title,[dot],save({color:preset,style},!mark)));}
        more.append(colors);
      }
      box.append(more);
    }
    shadow.replaceChildren(box);host.hidden=false;place();
  };
  // Text index for locating saved quotations: whitespace and invisible
  // characters are skipped, matching web/selection.ts on the reader side.
  const skip = code => code<=32||code===160||code===173||code===0x1680||(code>=0x2000&&code<=0x200d)||code===0x2028||code===0x2029||code===0x202f||code===0x205f||code===0x2060||code===0x3000||code===0xfeff;
  const strip = text => {let result='';text=String(text||'');for(let i=0;i<text.length;i++)if(!skip(text.charCodeAt(i)))result+=text[i];return result;};
  const build = () => {
    const nodes=[],at=[],offsets=[],parts=[];let length=0;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest('script,style,noscript,template,textarea,select,[data-knowbel-ui]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    while(walker.nextNode()&&length<3000000){
      const node=walker.currentNode,value=node.data,n=nodes.push(node)-1;let part='';
      for(let i=0;i<value.length;i++){if(skip(value.charCodeAt(i)))continue;part+=value[i];at.push(n);offsets.push(i);}
      parts.push(part);length+=part.length;
    }
    return {nodes,at,offsets,text:parts.join('')};
  };
  const main = node => !!node.parentElement?.closest('article,main,[role=main]');
  const locate = spec => {
    const needle=strip(spec?.text);if(!needle)return null;
    index??=build();
    const {text}=index,prefix=strip(spec.prefix),suffix=strip(spec.suffix),found=[];
    for(let from=0;found.length<200;){
      const at=text.indexOf(needle,from);if(at<0)break;from=at+1;let score=0;
      for(let i=1;i<=prefix.length&&at-i>=0&&prefix[prefix.length-i]===text[at-i];i++)score++;
      const end=at+needle.length;for(let i=0;i<suffix.length&&end+i<text.length&&suffix[i]===text[end+i];i++)score++;
      found.push({at,score});
    }
    if(!found.length||found.length>=200)return null;
    found.sort((a,b)=>b.score-a.score);
    let best=found[0];
    if(found.length>1&&(best.score<8||best.score===found[1].score)){
      // Navigation and related-article lists often repeat a heading. Prefer
      // a single equally good match inside the article itself.
      const top=found.filter(item=>item.score===best.score&&main(index.nodes[index.at[item.at]]));
      if(top.length!==1)return null;best=top[0];
    }
    const last=best.at+needle.length-1,range=document.createRange();
    try{
      range.setStart(index.nodes[index.at[best.at]],index.offsets[best.at]);
      range.setEnd(index.nodes[index.at[last]],index.offsets[last]+1);
    }catch{index=null;return null;}
    return range;
  };
  const color = (value, fallback) => typeof value==='string'&&CSS.supports('color',value)?value:fallback;
  const paintMarks = list => {
    requested=list;index=null;
    for(const key of [...(CSS.highlights?.keys?.()??[])])if(String(key).startsWith('knowbel-mark-'))CSS.highlights.delete(key);
    marks=[];const rules=[];
    if(!CSS.highlights||typeof Highlight!=='function')return 0;
    for(const mark of list.slice(0,1000)){
      const range=locate(mark);if(!range)continue;
      const key='knowbel-mark-'+marks.length,tint=color(mark.color,presets[0][0]);
      CSS.highlights.set(key,new Highlight(range));marks.push({...mark,range});
      if(mark.kind==='sticker')rules.push(`::highlight(${key}){background-color:color-mix(in srgb,${color(mark.paper,'#fff3c4')} 85%,transparent);text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:#9a7b10}`);
      else if(mark.style==='underline'||mark.style==='strikethrough')rules.push(`::highlight(${key}){text-decoration-line:${mark.style==='underline'?'underline':'line-through'};text-decoration-color:${tint};text-decoration-thickness:2px}`);
      else rules.push(`::highlight(${key}){background-color:color-mix(in srgb,${tint} 70%,transparent);color:inherit}`);
    }
    rules.push('::highlight(knowbel-flash){background-color:rgba(91,80,230,.3)}');
    rules.push('html[data-knowbel-tool=note] body *{cursor:copy!important}');
    if(sheet){sheet.replaceSync(rules.join('\n'));adopt();}
    return marks.length;
  };
  const paint = (list, focus) => {
    const marked=paintMarks(Array.isArray(list)?list:[]);retries=0;
    if(!focus)return {marked,found:false};
    const range=locate(focus);if(!range)return {marked,found:false};
    (range.startContainer.parentElement??document.body).scrollIntoView({block:'center',behavior:'instant'});
    clearTimeout(flashTimer);CSS.highlights?.set('knowbel-flash',new Highlight(range));
    flashTimer=setTimeout(()=>CSS.highlights?.delete('knowbel-flash'),2200);
    return {marked,found:true};
  };
  // Sites that render or hydrate content after load replace the text nodes a
  // highlight points to. Repaint when marks are lost; give up retrying marks
  // that never appear after a few attempts.
  const ours = record => ui(record.target)||record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(ui);
  new MutationObserver(records=>{
    if(records.every(ours))return;
    index=null;if(!requested.length||repaint)return;
    repaint=setTimeout(()=>{
      repaint=undefined;
      const lost=marks.some(mark=>!safeRange(mark.range)||mark.range.collapsed);
      if(lost||(marks.length<requested.length&&retries<5)){retries++;paintMarks(requested);}
    },600);
  }).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  const caret = (x,y) => {
    const point=document.caretPositionFromPoint?.(x,y);
    if(point){const r=document.createRange();r.setStart(point.offsetNode,point.offset);r.collapse(true);return r;}
    return document.caretRangeFromPoint?.(x,y);
  };
  const hit = event => {
    const point=caret(event.clientX,event.clientY);
    return point&&marks.find(mark=>safeRange(mark.range)&&mark.range.isPointInRange(point.startContainer,point.startOffset));
  };
  const blockRange = target => {
    const element=target instanceof Element?target.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,th,pre,dd,dt'):null;
    if(!element)return null;const r=document.createRange();r.selectNodeContents(element);return r;
  };
  document.addEventListener('pointerdown', event => {
    if(!event.isTrusted||ui(event.target)||event.button!==0)return;
    hide();cached=null;
  },true);
  document.addEventListener('mouseup',event=>{
    if(!event.isTrusted||ui(event.target)||event.button!==0)return;
    // Let the engine finish updating the selection for this click first.
    setTimeout(()=>{
      const selected=getSelection();
      if(selected?.rangeCount&&!selected.isCollapsed&&cache(selected.getRangeAt(0))){
        if(config.tool==='highlight'){notify('highlight',event);done();}else show();
        return;
      }
      const marked=hit(event);
      if(marked){
        cache(marked.range,marked.id);
        if(marked.diveId&&marked.diveId!==config.activeDiveId){notify('open-dive',event);done();}
        else show();
        return;
      }
      if(config.tool==='note'){const range=blockRange(event.target);if(range&&cache(range))notify('note',event);cached=null;}
    });
  },true);
  // A click belongs to the mark even when it sits inside a link.
  document.addEventListener('click',event=>{if(!ui(event.target)&&event.isTrusted&&getSelection()?.isCollapsed!==false&&hit(event)){event.preventDefault();event.stopPropagation();}},true);
  document.addEventListener('keydown',event=>{
    if(!event.isTrusted||event.target?.closest?.('input,textarea,select,[contenteditable=true],[contenteditable=""]'))return;
    const key=event.key.toLowerCase(),command=event.metaKey||event.ctrlKey;
    if(command&&['f','j','o','p','z','=','+','-','0','arrowleft','arrowright','g'].includes(key)){
      event.preventDefault();
      notify('key',event,{key,metaKey:event.metaKey,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey});
    }else if(key==='escape'){if(host&&!host.hidden){done();}else notify('key',event,{key});}
  },true);
  document.addEventListener('keyup',event=>{
    if(!event.isTrusted||!(event.key.startsWith('Arrow')||event.key==='Shift'))return;
    const selected=getSelection();if(selected?.rangeCount&&!selected.isCollapsed&&cache(selected.getRangeAt(0)))show();
  },true);
  addEventListener('scroll',()=>requestAnimationFrame(place),{capture:true,passive:true});
  addEventListener('resize',()=>requestAnimationFrame(place),{passive:true});
  // The document as the server sent it, for the offline archive. Saving the
  // live DOM instead would make its scripts run a second time on replay.
  let source;
  const encode = buffer => {
    const bytes=new Uint8Array(buffer);let text='';
    for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    return btoa(text);
  };
  const original = () => {
    if(!source){
      source={pending:true};
      nativeFetch(location.href,{cache:'force-cache',credentials:'include'}).then(response=>{
        if(!response.ok||!/html/i.test(response.headers.get('content-type')||''))throw new Error();
        return response.arrayBuffer();
      }).then(buffer=>{source=buffer.byteLength>16*1024*1024?{error:'This page is too large to save for offline reading.'}:{data:encode(buffer)};},
        ()=>{source={error:"The page's original document couldn't be read."};});
    }
    const current=source;if(!current.pending)source=undefined;return current;
  };
  const api={
    read,
    original,
    consume:()=>pending.shift()||null,
    configure:next=>{
      const previous=config.tool;config={...config,...next};fresh=config.style||'highlight';
      if(config.tool!==previous)hide();
      if(config.tool==='note')document.documentElement.dataset.knowbelTool='note';else delete document.documentElement.dataset.knowbelTool;
    },
    paint,
    hide,
  };
  Object.freeze(api);Object.defineProperty(window,'__knowbelPage',{value:api,configurable:false,writable:false});
})();
