// Uses the real system WebView and production commands without loading the
// reader, starting its server, or accessing its library/keychain.
// cargo run --offline --manifest-path src-tauri/Cargo.toml --example import-browser-smoke
// Pass an HTTP(S) URL after -- to exercise a live site too.
#[path = "../src/browser.rs"]
mod browser;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

async fn capture(
    main: &tauri::Webview,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        match browser::capture_import_browser(main.clone(), app.clone(), "smoke".into()).await {
            Ok(value) => return Ok(value),
            Err(error) if Instant::now() >= until => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn main() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/article", server.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let served = requests.clone();
    // When the delayed request a settling page makes was answered.
    let slow_done = Arc::new(Mutex::new(None::<Instant>));
    let answered = slow_done.clone();
    std::thread::spawn(move || {
        for mut stream in server.incoming().flatten() {
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap_or(0);
            served.fetch_add(1, Ordering::SeqCst);
            let head = String::from_utf8_lossy(&request[..count]).to_string();
            if head.starts_with("GET /slow") {
                let answered = answered.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                    *answered.lock().unwrap() = Some(Instant::now());
                });
                continue;
            }
            if head.starts_with("GET /settle") {
                let html = "<!doctype html><html><body><p>Loads more after the load event.</p><script>addEventListener('load',()=>setTimeout(()=>fetch('/slow').then(r=>r.text()),300))</script></body></html>";
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html).as_bytes());
                continue;
            }
            let challenge =
                String::from_utf8_lossy(&request[..count]).starts_with("GET /challenge");
            let html = if challenge {
                "<html><head><title>Just a moment</title></head><body>Verify you are human</body></html>"
            } else {
                r#"<!doctype html><html><head><title>System browser capture</title></head><body>
                <article><h1>System browser capture</h1><p>This article has enough readable context to test the real system browser and its rendered document capture.</p>
                <input value="private-input"><div contenteditable="true">private-editor</div>
                <svg id="moving-diagram" viewBox="0 0 80 30"><circle id="moving-dot" cx="0" cy="10" r="4"/></svg><canvas aria-label="Browser drawn chart" width="40" height="30"></canvas>
                <script>setInterval(()=>{const dot=document.querySelector('#moving-dot');dot.setAttribute('cx',String((Number(dot.getAttribute('cx'))+3)%80))},100);const p=document.createElement('p');p.textContent='JavaScript rendered this passage.';document.querySelector('article').append(p);const c=document.querySelector('canvas').getContext('2d');c.fillStyle='red';c.fillRect(0,0,40,30);</script>
                </article></body></html>"#
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let live_url = std::env::args().nth(1);
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.knowbelreader.browser-smoke".into();
    tauri::Builder::default().manage(browser::PageState::default()).setup(move |app| {
        let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse().unwrap()))
            .incognito(true).title("Knowbel browser test").visible(false).build()?;
        let main: tauri::Webview = main.as_ref().clone();
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let result: Result<(), String> = async {
                browser::open_import_browser(main.clone(), handle.clone(), url.clone(), "smoke".into(), browser::PageBounds { x: 20., y: 60., width: 1000., height: 720. }, None).await?;
                let value = capture(&main, &handle).await?;
                if handle.windows().len()!=1 { return Err("A separate browser window was created".into()); }
                let child=handle.get_webview(browser::LABEL).ok_or("Missing child page")?;
                if child.window().label()!="main" { return Err("Page is not embedded in reader window".into()); }
                let before=browser::evaluate(&child,"({x:document.querySelector('#moving-dot').getAttribute('cx')})".into()).await?;
                std::thread::sleep(Duration::from_millis(750));
                let after=browser::evaluate(&child,"({x:document.querySelector('#moving-dot').getAttribute('cx')})".into()).await?;
                if before==after { return Err("Live diagram stopped animating".into()); }
                browser::evaluate(&child,"(() => { const p=document.querySelector('article p'),r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);return true; })()".into()).await?;
                let selected=browser::read_page_selection(main.clone(),handle.clone(),"smoke".into()).await?;
                if !selected["text"].as_str().unwrap_or("").contains("enough readable context"){return Err("Live page selection was lost".into());}
                let marked=browser::decorate_page(main.clone(),handle.clone(),"smoke".into(),serde_json::json!([{"id":"smoke-mark","text":"JavaScript rendered this passage.","prefix":"","suffix":"","color":"#ffe08a","style":"highlight","kind":"highlight"}]),Some(serde_json::json!({"text":"JavaScript rendered this passage.","prefix":"","suffix":""})),Some(serde_json::json!({"tool":"select","color":"#ffe08a","style":"highlight"}))).await?;
                if marked["marked"]!=1||marked["found"]!=true{return Err(format!("Live page mark failed: {marked}"));}
                // Offline replay: the archive restores the original document and
                // its scripts without contacting the site, and runs them once.
                let archive=browser::page_archive(&handle,"smoke").await?;
                let before_replay=requests.load(Ordering::SeqCst);
                browser::replay_archive(&handle,"smoke",&url,archive.clone())?;
                std::thread::sleep(Duration::from_millis(1500));
                let state="({url:location.href,rendered:[...document.querySelectorAll('p')].filter(p=>p.textContent==='JavaScript rendered this passage.').length,x:document.querySelector('#moving-dot')?.getAttribute('cx'),red:document.querySelector('canvas')?.getContext('2d').getImageData(1,1,1,1).data[0],bridge:!!window.__knowbelPage})";
                let replayed=browser::evaluate(&child,state.into()).await?;
                // Hidden test windows throttle timers, so poll for movement.
                let mut moved=replayed.clone();
                for _ in 0..20{std::thread::sleep(Duration::from_millis(250));moved=browser::evaluate(&child,state.into()).await?;if moved["x"]!=replayed["x"]{break}}
                println!("Archive: {} bytes; replay {replayed}; then {moved}; requests during replay {}",archive.len(),requests.load(Ordering::SeqCst)-before_replay);
                if replayed["url"]!=url.as_str()||replayed["rendered"]!=1||replayed["red"]!=255||replayed["bridge"]!=true{return Err(format!("Archive replay differs from the page: {replayed}"));}
                if replayed["x"]==moved["x"]{return Err("Archived page scripts did not run".into());}
                if requests.load(Ordering::SeqCst)!=before_replay{return Err("Archive replay contacted the site".into());}
                if browser::replay_archive(&handle,"smoke",&url,b"<html>not an archive".to_vec()).is_ok(){return Err("Accepted a non-archive".into());}
                // A fresh view can open straight into the archive, and going
                // live again replaces it, since WebKit won't navigate it.
                browser::open_import_browser(main.clone(),handle.clone(),url.clone(),"smoke".into(),browser::PageBounds{x:20.,y:60.,width:1000.,height:720.},Some(true)).await?;
                browser::replay_archive(&handle,"smoke",&url,archive)?;
                let child=handle.get_webview(browser::LABEL).ok_or("Missing archive view")?;
                let mut fresh=serde_json::Value::Null;
                for _ in 0..20{std::thread::sleep(Duration::from_millis(250));fresh=browser::evaluate(&child,state.into()).await?;if fresh["rendered"]==1{break}}
                if fresh["url"]!=url.as_str()||fresh["rendered"]!=1{return Err(format!("Fresh archive view failed: {fresh}"));}
                if requests.load(Ordering::SeqCst)!=before_replay{return Err("Opening the archive contacted the site".into());}
                if browser::open_import_browser(main.clone(),handle.clone(),url.clone(),"smoke".into(),browser::PageBounds{x:20.,y:60.,width:1000.,height:720.},None).await?{return Err("Reused an archived view for the live page".into());}
                let child=handle.get_webview(browser::LABEL).ok_or("Missing live view")?;
                for _ in 0..40{std::thread::sleep(Duration::from_millis(100));if requests.load(Ordering::SeqCst)>before_replay{break}}
                let mut live=serde_json::Value::Null;
                for _ in 0..40{std::thread::sleep(Duration::from_millis(100));if let Ok(value)=browser::evaluate(&child,"({ready:document.readyState,bridge:!!window.__knowbelPage})".into()).await{live=value;if live["ready"]=="complete"&&live["bridge"]==true{break}}}
                if requests.load(Ordering::SeqCst)==before_replay||live["ready"]!="complete"{return Err(format!("Live page did not load after the archive: {live}"));}
                if browser::import_browser_action(main.clone(),handle.clone(),"stale-owner".into(),"close".into(),None).await.is_ok(){ return Err("Stale pane closed another page".into()); }
                browser::position_import_browser(main.clone(), handle.clone(), "smoke".into(), browser::PageBounds{x:30.,y:90.,width:900.,height:600.}, true).await?;

                let html = value["html"].as_str().ok_or("Missing captured HTML")?;
                for expected in ["JavaScript rendered this passage.", "data:image/png;base64,", "<base href="] {
                    if !html.contains(expected) { return Err(format!("Capture lost {expected}")); }
                }
                for forbidden in ["<script", "private-input", "private-editor", "data-knowbel-import-ui"] {
                    if html.contains(forbidden) { return Err(format!("Capture retained {forbidden}")); }
                }
                let remote = handle.get_webview(browser::LABEL).ok_or("Browser missing")?;
                if browser::capture_import_browser(remote.clone(), handle.clone(), "smoke".into()).await.is_ok()
                    || browser::print_reader(remote.clone()).await.is_ok()
                    || browser::import_browser_action(remote, handle.clone(), "smoke".into(), "close".into(), None).await.is_ok() {
                    return Err("Remote browser accessed a trusted command".into());
                }
                if browser::import_browser_action(main.clone(), handle.clone(), "smoke".into(), "navigate".into(), Some("file:///etc/passwd".into())).await.is_ok() {
                    return Err("Browser allowed a local file".into());
                }
                browser::import_browser_action(main.clone(), handle.clone(), "smoke".into(), "navigate".into(), Some(url.replace("/article", "/challenge"))).await?;
                std::thread::sleep(Duration::from_secs(2));
                let error = browser::capture_import_browser(main.clone(), handle.clone(), "smoke".into()).await.unwrap_err();
                if !error.contains("verification") { return Err(format!("Unexpected challenge result: {error}")); }
                // The page reports it has settled only once the request it
                // starts after loading has been answered, and promptly then.
                browser::open_import_browser(main.clone(), handle.clone(), url.replace("/article", "/settle"), "smoke".into(), browser::PageBounds { x: 20., y: 60., width: 1000., height: 720. }, None).await?;
                let opened = Instant::now();
                let mut settled = None;
                while opened.elapsed() < Duration::from_secs(20) {
                    if let Ok(event) = browser::read_page_interaction(main.clone(), handle.clone(), "smoke".into()).await {
                        if event["action"] == "settled" && event["url"].as_str().is_some_and(|value| value.ends_with("/settle")) { settled = Some(Instant::now()); break; }
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let settled = settled.ok_or("The page never reported that it settled")?;
                let answered = (*slow_done.lock().unwrap()).ok_or("The page's delayed request was never answered")?;
                println!("Settled {:?} after load started, {:?} after its delayed request was answered", settled - opened, settled.saturating_duration_since(answered));
                if settled < answered { return Err("The page reported settled while a request was in flight".into()); }
                if settled - answered > Duration::from_secs(6) { return Err("The page reported settled long after it went quiet".into()); }
                if let Some(url) = live_url {
                    browser::open_import_browser(main.clone(), handle.clone(), url, "smoke".into(), browser::PageBounds { x: 20., y: 60., width: 1000., height: 720. }, None).await?;
                    let opened = Instant::now();
                    let mut settled = None;
                    while opened.elapsed() < Duration::from_secs(40) {
                        if let Ok(event) = browser::read_page_interaction(main.clone(), handle.clone(), "smoke".into()).await { if event["action"] == "settled" { settled = Some(opened.elapsed()); break; } }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    println!("Live page settled after {:?}", settled.ok_or("The live page never reported that it settled")?);
                    let captured = capture(&main, &handle).await?;
                    let child=handle.get_webview(browser::LABEL).ok_or("Missing live child")?;
                    let controls=browser::evaluate(&child,r#"(() => ({buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,aria:b.getAttribute('aria-label')})).filter(b=>/play|pause/i.test(b.text||b.aria||'')),animations:document.getAnimations().length,figures:document.querySelectorAll('figure').length}))()"#.into()).await?;
                    println!("Live controls: {}",controls);
                    browser::evaluate(&child,r#"(() => {const b=document.querySelector('button[aria-label="Play animation"],button[aria-label="Pause animation"]');if(!b)return {error:"First animation control missing"};b.scrollIntoView({block:"center"});if(b.getAttribute('aria-label')==='Play animation')b.click();return true;})()"#.into()).await?;
                    std::thread::sleep(Duration::from_millis(1200));
                    let playing=browser::evaluate(&child,r#"(() => ({paused:!!document.querySelector('button[aria-label="Pause animation"]'),first:document.querySelector('figure')?.innerHTML.slice(-400),animations:document.getAnimations().length}))()"#.into()).await?;
                    println!("After Play: {}",playing);
                    if playing["paused"]!=true{return Err("OpenAI animation did not respond to Play".into());}
                    let archive=browser::page_archive(&handle,"smoke").await?;
                    let live=child.url().map_err(|e|e.to_string())?.to_string();
                    browser::replay_archive(&handle,"smoke",&live,archive.clone())?;
                    std::thread::sleep(Duration::from_secs(4));
                    let replay=browser::evaluate(&child,r#"(() => {const b=document.querySelector('button[aria-label="Play animation"],button[aria-label="Pause animation"]');if(b){b.scrollIntoView({block:"center"});if(b.getAttribute('aria-label')==='Play animation')b.click();}return {url:location.href,figures:document.querySelectorAll('figure').length,control:!!b,text:document.body.innerText.length};})()"#.into()).await?;
                    std::thread::sleep(Duration::from_millis(1200));
                    let replay_playing=browser::evaluate(&child,r#"(() => ({paused:!!document.querySelector('button[aria-label="Pause animation"]'),animations:document.getAnimations().length}))()"#.into()).await?;
                    println!("Archived live page: {} bytes; {replay}; after Play {replay_playing}",archive.len());
                    if replay_playing["paused"]!=true{return Err("Archived OpenAI animation did not respond to Play".into());}

                    println!("Live page: {} ({} HTML bytes)", captured["title"], captured["html"].as_str().unwrap_or("").len());
                }
                browser::import_browser_action(main.clone(), handle.clone(), "smoke".into(), "close".into(), None).await?;
                std::thread::sleep(Duration::from_millis(300));
                if browser::capture_import_browser(main, handle.clone(), "smoke".into()).await.is_ok() { return Err("Closed browser captured content".into()); }
                Ok(())
            }.await;
            match result {
                Ok(()) => { println!("PASS: single reader window, embedded child bounds, live animation, selections/marks, rendered capture, command isolation, URL policy, challenge detection, close lifecycle"); handle.exit(0); }
                Err(error) => { eprintln!("FAIL: {error}"); handle.exit(1); }
            }
        });
        Ok(())
    }).run(context).expect("browser test runtime");
}
