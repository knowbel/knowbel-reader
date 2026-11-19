// End-to-end desktop reader check. Uses /tmp for every app directory and
// synthetic documents only; no real library, keychain or AI provider access.
// Run Vite on 127.0.0.1:5178, then cargo run --offline --example reader-page-smoke.
#[path = "../src/browser.rs"]
mod browser;
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};
#[tauri::command]
fn get_api_key(window: Webview, provider: String) -> Result<Option<String>, String> {
    browser::trusted(&window)?;
    let _ = provider;
    Ok(None)
}
async fn eval(main: &Webview, code: &str) -> Result<serde_json::Value, String> {
    browser::evaluate(main,format!("(() => {{ window.__advanceTestFrames?.(); const value=({code}); return value===undefined?null:value; }})()")).await.map_err(|error|format!("{error}; evaluating {code}"))
}
async fn wait(main: &Webview, condition: &str) -> Result<(), String> {
    for _ in 0..150 {
        if eval(main, condition).await? == true {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Timed out: {condition}\n{}",
        eval(main, "document.body.innerText").await?
    ))
}
fn main() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/article", server.local_addr().unwrap());
    let html=r#"<!doctype html><html><head><title>Embedded UI test</title><style>body{background:rgb(210,230,240);min-height:2400px}#moving{animation:slide 1s infinite alternate}@keyframes slide{from{transform:translateX(0)}to{transform:translateX(50px)}}</style></head><body><article><h1>Embedded UI test</h1><p>Select this precise passage for a saved highlight.</p><p>This is a substantial test article about preserving original web pages inside the reader while keeping independent saved source text for study tools. Its paragraphs provide sufficient context for the article extractor to recognize the main content without fetching a protected page again.</p><div id="moving">Live animated content</div></article><script>window.__pageIdentity=Math.random();window.__ticks=0;setInterval(()=>window.__ticks++,100)</script></body></html>"#.to_string();
    let served = html.clone();
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = requests.clone();
    std::thread::spawn(move || {
        for mut stream in server.incoming().flatten() {
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",served.len(),served).as_bytes());
        }
    });
    let temp =
        std::env::temp_dir().join(format!("knowbel-reader-page-smoke-{}", std::process::id()));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.knowbelreader.reader-page-smoke".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(temp.clone()),
    );
    context.config_mut().build.dev_url = Some("http://127.0.0.1:5178".parse().unwrap());
    tauri::Builder::default().manage(browser::PageState::default())
    .plugin(tauri_plugin_fs::init()).plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![get_api_key,browser::open_import_browser,browser::position_import_browser,browser::import_browser_action,browser::capture_import_browser,browser::read_page_selection,browser::read_page_interaction,browser::decorate_page,browser::print_reader,browser::save_page_archive,browser::load_page_archive])
    .setup(move|app|{
        let id="a".repeat(64);
        let dir=app.path().app_data_dir()?.join("library").join(&id);std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("source.html"),&html)?;
        std::fs::write(dir.join("meta.json"),serde_json::to_vec(&serde_json::json!({"docId":id,"title":"Embedded UI test","format":"html","fileName":"page.html","byteLength":html.len(),"addedAt":"2026-11-16T00:00:00Z","openedAt":"","source":{"kind":"web","format":"article","url":url,"canonicalUrl":url,"finalUrl":url,"fetchedAt":"2026-11-16T00:00:00Z"}}))?)?;
        let loaded=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)); let load_flag=loaded.clone();
        let main=WebviewWindowBuilder::new(app,"main",WebviewUrl::External("http://127.0.0.1:5178".parse().unwrap())).incognito(true).visible(true).position(20000.,20000.).inner_size(1440.,1000.)
          .on_page_load(move |_,payload| {println!("Reader load: {:?} {}",payload.event(),payload.url());if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){load_flag.store(true,std::sync::atomic::Ordering::SeqCst);}})
          .initialization_script(r#"
            window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
            const frames=new Map();let fid=0;requestAnimationFrame=f=>{frames.set(++fid,f);return fid};cancelAnimationFrame=id=>frames.delete(id);
            window.__advanceTestFrames=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(f=>f(performance.now()))};
            const original=fetch;window.fetch=(url,opts)=>String(url).includes('/api/web/fetch')?Promise.resolve(new Response(JSON.stringify({error:'Protected fixture',upstreamStatus:403}),{status:502,headers:{'Content-Type':'application/json'}})):original(url,opts);
          "#).build()?;
        let main:Webview=main.as_ref().clone();let handle=app.handle().clone();
        tauri::async_runtime::spawn(async move{
          let result:Result<(),String>=async{
            for _ in 0..100{if loaded.load(std::sync::atomic::Ordering::SeqCst){break}std::thread::sleep(Duration::from_millis(100));}
            wait(&main,"!!document.querySelector('.library-card-open')").await?;
            eval(&main,"document.querySelector('.library-card-open').click()").await?;
            wait(&main,"!!document.querySelector('.embedded-document-page')").await?;
            for _ in 0..60{let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));if handle.get_webview(browser::LABEL).is_some(){break}}
            let child=handle.get_webview(browser::LABEL).ok_or("Original page did not mount")?;
            if handle.windows().len()!=1{return Err("Reader opened a separate window".into())}
            for _ in 0..10{let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));}
            let bounds=eval(&main,"(() => {const r=document.querySelector('.embedded-document-page').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()").await?;
            if bounds["width"].as_f64().unwrap_or(0.)<400.||bounds["height"].as_f64().unwrap_or(0.)<400.{return Err(format!("Page pane collapsed: {bounds}"))}
            let actual=child.bounds().map_err(|e|e.to_string())?;println!("Reader slot {bounds}; native child {actual:?}");
            let value=browser::evaluate(&child,"({background:getComputedStyle(document.body).backgroundColor,ticks:window.__ticks})".into()).await?;
            let identity=browser::evaluate(&child,"({id:window.__pageIdentity})".into()).await?;
            if value["background"]!="rgb(210, 230, 240)"{return Err(format!("Original styles missing: {value}"))}
            let private_path=serde_json::to_string(&dir.join("meta.json").to_string_lossy()).unwrap();
            browser::evaluate(&child,format!("(() => {{const ipc=window.__TAURI_INTERNALS__;window.__scopeCheck=ipc?'pending':'unavailable';if(ipc)ipc.invoke('plugin:fs|read_text_file',{{path:{private_path},options:{{}}}}).then(()=>window.__scopeCheck='ALLOWED',()=>window.__scopeCheck='blocked');return true;}})()")).await?;
            for _ in 0..20{let state=browser::evaluate(&child,"({result:window.__scopeCheck})".into()).await?;if state["result"]=="ALLOWED"{return Err("Remote child inherited reader filesystem privileges".into())}if state["result"]!="pending"{break}std::thread::sleep(Duration::from_millis(100));}
            browser::evaluate(&child,"(() => {const p=document.querySelector('p'),r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);return true})()".into()).await?;
            // The page toolbar only accepts trusted clicks; drive the reader's
            // handler for that toolbar action with the page's live selection.
            let selected=browser::evaluate(&child,"window.__knowbelPage.read()".into()).await?;
            eval(&main,&format!("window.__knowbelPageEvent({{...{selected},action:'highlight'}})")).await?;
            wait(&main,"document.querySelector('.nb-entry')?.textContent.includes('Select this precise passage')").await?;
            let mut painted=serde_json::Value::Null;
            for _ in 0..40{painted=browser::evaluate(&child,"({marks:[...CSS.highlights.keys()].filter(k=>k.startsWith('knowbel-mark-')).length,text:CSS.highlights.get('knowbel-mark-0')?.values().next().value?.toString()})".into()).await?;if painted["marks"].as_u64().unwrap_or(0)>0{break}std::thread::sleep(Duration::from_millis(100));}
            if painted["text"]!="Select this precise passage for a saved highlight."{return Err(format!("Live page highlight was not painted: {painted}"))}
            eval(&main,"[...document.querySelectorAll('.web-document-toolbar button')].find(b=>b.textContent==='Study text').click()").await?;
            wait(&main,"!document.querySelector('.native-study-source').hidden && !!document.querySelector('.flow-mark')").await?;
            if handle.get_webview(browser::LABEL).is_none(){return Err("Switching to Study text discarded the live page".into())}
            eval(&main,"[...document.querySelectorAll('.web-document-toolbar button')].find(b=>b.textContent==='Page').click()").await?;
            wait(&main,"document.querySelector('.original-page-source')?.hidden===false").await?;
            let resumed=browser::evaluate(&child,"({id:window.__pageIdentity})".into()).await?;
            if identity!=resumed{return Err("Switching modes reloaded the original page".into())}
            let width=browser::evaluate(&child,"({width:innerWidth})".into()).await?;
            eval(&main,"document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'+',metaKey:true,bubbles:true}))").await?;
            for _ in 0..20{let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));}
            let zoomed=browser::evaluate(&child,"({width:innerWidth})".into()).await?;
            if zoomed["width"].as_f64().unwrap_or(0.)>=width["width"].as_f64().unwrap_or(0.){return Err("Reader zoom did not affect original page".into())}
            let owner="reader-".to_string()+&"a".repeat(64);
            browser::import_browser_action(main.clone(),handle.clone(),owner,"scroll".into(),Some("240".into())).await?;
            eval(&main,"document.querySelector('button[aria-label=\"Library\"]').click()").await?;
            wait(&main,"!!document.querySelector('.library')").await?;
            let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(dir.join("meta.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            if saved["view"]["pageScroll"].as_f64().unwrap_or(0.)<230.{return Err(format!("Page position was not saved: {saved}"))}
            eval(&main,"document.querySelector('.library-card-open').click()").await?;
            wait(&main,"!!document.querySelector('.original-page-source')").await?;
            let mut restored=false;
            for _ in 0..50{
                let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));
                if let Some(view)=handle.get_webview(browser::LABEL){
                    if let Ok(value)=browser::evaluate(&view,"({top:scrollY})".into()).await{if value["top"].as_f64().unwrap_or(0.)>=230.{restored=true;break}}
                }
            }
            if !restored{return Err("Original page did not restore its saved position".into())}
            // The first visit saves the original page; offline, the reader
            // replays it with its scripts and saved marks, without the site.
            let archive=dir.join("page.webarchive");
            for _ in 0..150{if archive.exists(){break}let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));}
            let bytes=std::fs::read(&archive).map_err(|_|"The original page was not saved for offline reading".to_string())?;
            if !bytes.starts_with(b"bplist00"){return Err("Saved page is not a web archive".into())}
            eval(&main,r#"document.querySelector('button[aria-label="Library"]').click()"#).await?;
            wait(&main,"!!document.querySelector('.library')").await?;
            let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(dir.join("meta.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            if !saved["source"]["pageArchivedAt"].is_string(){return Err(format!("Saved page time missing: {saved}"))}
            eval(&main,"window.__onLine=Object.getOwnPropertyDescriptor(Navigator.prototype,'onLine'),Object.defineProperty(Navigator.prototype,'onLine',{get:()=>false,configurable:true}),true").await?;
            let before_offline=requests.load(std::sync::atomic::Ordering::SeqCst);
            eval(&main,"document.querySelector('.library-card-open').click()").await?;
            wait(&main,"document.querySelector('.web-document-toolbar small')?.textContent.startsWith('Saved page')").await?;
            let mut replay=serde_json::Value::Null;
            for _ in 0..50{
                let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));
                if let Some(view)=handle.get_webview(browser::LABEL){
                    if let Ok(value)=browser::evaluate(&view,"({href:location.href,scripts:typeof window.__pageIdentity,bridge:!!window.__knowbelPage,marks:[...CSS.highlights.keys()].filter(k=>k.startsWith('knowbel-mark-')).length})".into()).await{replay=value;if replay["marks"].as_u64().unwrap_or(0)>0{break}}
                }
            }
            if replay["href"]!=url.as_str()||replay["scripts"]!="number"||replay["bridge"]!=true||replay["marks"].as_u64().unwrap_or(0)==0{return Err(format!("Offline saved page differs: {replay}"))}
            if requests.load(std::sync::atomic::Ordering::SeqCst)!=before_offline{return Err("Offline saved page contacted the site".into())}
            eval(&main,"Object.defineProperty(Navigator.prototype,'onLine',window.__onLine),true").await?;
            eval(&main,"[...document.querySelectorAll('.web-document-toolbar button')].find(b=>b.textContent==='Load live page').click()").await?;
            wait(&main,"document.querySelector('.web-document-toolbar small')?.textContent.startsWith('Live page')").await?;
            for _ in 0..50{if requests.load(std::sync::atomic::Ordering::SeqCst)>before_offline{break}let _=eval(&main,"true").await;std::thread::sleep(Duration::from_millis(100));}
            if requests.load(std::sync::atomic::Ordering::SeqCst)==before_offline{return Err("Live page did not load after the saved page".into())}
            eval(&main,r#"document.querySelector('button[aria-label="Library"]').click()"#).await?;
            wait(&main,"!!document.querySelector('.library')").await?;
            // A blocked fetch must open inline, save automatically, and hand the
            // same running document to the reader without a second page load.
            eval(&main,"[...document.querySelectorAll('.library-add')].find(b=>b.textContent.includes('Add from URL')).click()").await?;
            wait(&main,"!!document.querySelector('.url-dialog-input')").await?;
            let address=serde_json::to_string(&(url.clone()+"?fresh=1")).unwrap();
            eval(&main,&format!("(() => {{const e=document.querySelector('.url-dialog-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,{address});e.dispatchEvent(new Event('input',{{bubbles:true}}));return true}})()")).await?;
            eval(&main,"document.querySelector('.url-dialog button[type=submit]').click()").await?;
            wait(&main,"!!document.querySelector('.url-dialog--page .embedded-document-page')").await?;
            wait(&main,"!!document.querySelector('.native-reader .embedded-document-page') && !document.querySelector('.url-dialog')").await?;
            if handle.windows().len()!=1{return Err("Blocked import opened a separate window".into())}
            let errors=eval(&main,"window.__errors").await?;
            if errors.as_array().is_some_and(|errors|!errors.is_empty()){return Err(format!("Reader errors: {errors}"))}
            eval(&main,"document.querySelector('button[aria-label=\"Library\"]').click()").await?;
            wait(&main,"!!document.querySelector('.library')").await?;
            for _ in 0..30{if handle.get_webview(browser::LABEL).is_none(){break}std::thread::sleep(Duration::from_millis(100));}
            if handle.get_webview(browser::LABEL).is_some(){return Err("Page survived reader closure".into())}
            Ok(())
          }.await;
          match result{Ok(())=>{println!("PASS: original page inside reader, original CSS, selection/highlight/Notebook, Study text, offline saved page, inline blocked import, automatic save, cleanup");handle.exit(0)},Err(error)=>{eprintln!("FAIL: {error}");handle.exit(1)}}
          let _=std::fs::remove_dir_all(temp);
        });Ok(())
    }).run(context).expect("reader test runtime");
}
