import Cocoa
import WebKit

// Serve the production bundle through the desktop asset scheme. Matching
// the PDF signature sniff catches invalid JS MIME types as well as WebKit's
// module evaluation order. No network server or user library is involved.
class Assets: NSObject, WKURLSchemeHandler {
  let root: URL
  init(root: String) { self.root = URL(fileURLWithPath: root) }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let url = task.request.url!
    let path = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
    let file = root.appendingPathComponent(path).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/") else {
      task.didFailWithError(NSError(domain: "test-assets", code: 403)); return
    }
    do {
      let data = try Data(contentsOf: file)
      var mime = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "svg": "image/svg+xml"][file.pathExtension] ?? "application/octet-stream"
      if data.prefix(1024).range(of: Data("%PDF".utf8)) != nil { mime = "application/pdf" }
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": mime, "Access-Control-Allow-Origin": "*"])!
      task.didReceive(response); task.didReceive(data); task.didFinish()
    } catch { task.didFailWithError(error) }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

class Errors: NSObject, WKScriptMessageHandler {
  var messages = [String]()
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    let value = String(describing: message.body)
    messages.append(value)
    print("JavaScript error:", value)
  }
}

let fixturesJSON = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let fixtures = try JSONSerialization.jsonObject(with: Data(fixturesJSON.utf8)) as! [[String: Any]]
let assets = Assets(root: CommandLine.arguments[1])
let errors = Errors()
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
// Automated macOS sessions may have no active display even for a visible
// window. Keep the test webview running rather than throttling its frames.
if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
configuration.setURLSchemeHandler(assets, forURLScheme: "tauri")
configuration.userContentController.add(errors, name: "errors")
configuration.userContentController.addUserScript(WKUserScript(source: """
// Drive frame callbacks from the native test loop. A remote macOS host may
// have no CVDisplayLink, leaving native rAF suspended regardless of scheduling
// preferences. Layout, canvases, fonts, editing, and module loading remain WebKit.
let frameId=0; const frames=new Map();
window.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id;};
window.cancelAnimationFrame=id=>frames.delete(id);
window.__advanceTestFrames=()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(performance.now());};
window.addEventListener('error', e => window.webkit.messageHandlers.errors.postMessage(e.message));
window.addEventListener('unhandledrejection', e => window.webkit.messageHandlers.errors.postMessage(String(e.reason)));
const logError = console.error;
console.error = (...args) => { window.webkit.messageHandlers.errors.postMessage(args.map(String).join(' ')); logError(...args); };
""", injectionTime: .atDocumentStart, forMainFrameOnly: true))
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1000), configuration: configuration)
let window = NSWindow(contentRect: NSRect(x: 20000, y: 20000, width: 1440, height: 1000), styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = view
window.orderFront(nil)
view.load(URLRequest(url: URL(string: "tauri://localhost/")!))

// Each navigation reloads the whole JavaScript runtime before opening a
// library entry. Importing a PDF first would mask the initialization bug.
var seeded = false
var busy = false
var opened = false
var index = 0
var ticks = 0
var annotationUI: String?
var notebookCheckStarted = false
var lastState: [String: Any] = [:]
let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
  if busy { return }
  ticks += 1
  if !errors.messages.isEmpty { exit(1) }
  if ticks > 240 { print("FAIL: desktop reader timed out at fixture", index, "state:", lastState); exit(1) }
  busy = true
  // A snapshot drives WebKit's display pipeline in automated/remote macOS
  // sessions, where WindowServer can report even a key window as occluded.
  view.takeSnapshot(with: nil) { _, error in
    if let error = error { print("FAIL: WebKit snapshot:", error); exit(1) }
  }
  view.evaluateJavaScript("""
window.__advanceTestFrames?.();
JSON.stringify({library: !!document.querySelector('.library-card-open'), empty: !!document.querySelector('.library-empty'),
  body: document.body?.innerText ?? '', core: !!window.pdfjsLib, native: !!document.querySelector('.native-reader'),
  canvas: [...document.querySelectorAll('.PdfHighlighter canvas')].some(c => c.width > 0 && c.height > 0 && c.getBoundingClientRect().width > 0),
  visibility: document.visibilityState, textLayers: document.querySelectorAll('.textLayer').length, textSpans: document.querySelectorAll('.textLayer span').length, textContent: document.querySelector('.PdfHighlighter')?.textContent?.slice(0,500),
  controls: !!document.querySelector('.page-nav'), annotations: !!document.querySelector('.nb-header'), notebookCheck: window.__notebookCheck ?? null, notebookStage: window.__notebookStage ?? null,
  annotationUI: JSON.stringify([document.querySelector('.nb-header h2')?.textContent, !!document.querySelector('input[aria-label=\"Search notebook\"]'), document.querySelector('.notebook-dock')?.getBoundingClientRect().width])})
"""
  ) { value, error in
    defer { busy = false }
    if let error = error { print("FAIL:", error); exit(1) }
    guard let text = value as? String, let data = text.data(using: .utf8),
      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    lastState = state
    if ticks % 20 == 0 { print("WebKit fixture", index, "stage:", state["notebookStage"] ?? "reader", "canvas:", state["canvas"] ?? false, "notebook:", state["annotations"] ?? false); fflush(stdout) }
    if !seeded && (state["empty"] as? Bool == true || state["library"] as? Bool == true) {
      seeded = true
      // Seed only synthetic source bytes and metadata into this test profile.
      view.evaluateJavaScript("""
window.__seed = new Promise((resolve, reject) => {
  const request = indexedDB.open('knowbelreader', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction(['documents', 'files'], 'readwrite');
    for (const fixture of \(fixturesJSON)) {
      transaction.objectStore('documents').put(fixture.meta);
      transaction.objectStore('files').put(new Uint8Array(fixture.bytes), fixture.meta.docId);
    }
    transaction.oncomplete = () => { db.close(); resolve(true); };
    transaction.onerror = () => reject(transaction.error);
  };
});
window.__seed.then(() => location.reload()); undefined;
"""
      ) { _, error in if let error = error { print("FAIL:", error); exit(1) } }
      return
    }
    if !seeded { return }
    let fixture = fixtures[index]
    let meta = fixture["meta"] as! [String: Any]
    if !opened && state["library"] as? Bool == true {
      let title = meta["title"] as! String
      let literal = String(data: try! JSONSerialization.data(withJSONObject: ["Open “\(title)”"]), encoding: .utf8)!
      opened = true
      view.evaluateJavaScript("[...document.querySelectorAll('.library-card-open')].find(b => b.title === \(literal)[0]).click()") { _, error in
        if let error = error { print("FAIL:", error); exit(1) }
      }
      return
    }
    let native = fixture["native"] as! Bool
    let rendered = native ? state["native"] as? Bool == true : state["canvas"] as? Bool == true && state["controls"] as? Bool == true
    if opened && rendered && state["annotations"] as? Bool == true && (state["body"] as? String ?? "").contains(fixture["expect"] as! String) {
      if native && state["core"] as? Bool == true { print("FAIL: Markdown loaded PDF.js"); exit(1) }
      if !notebookCheckStarted {
        notebookCheckStarted = true
        let question = String(data: try! JSONSerialization.data(withJSONObject: ["Explain " + (fixture["expect"] as! String)]), encoding: .utf8)!
        view.evaluateJavaScript("""
window.__notebookCheck = 'running';
(async () => {
  const wait = async (check) => { for (let i=0;i<200;i++) { if(check()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error('Notebook interaction timed out: '+String(check)+'; '+document.body.innerText.slice(-2500)); };
  const originalFetch = window.fetch;
  window.fetch = async (url,opts) => String(url).includes('/api/ask/stream') ? new Response('data: '+JSON.stringify({text:'A grounded WebKit explanation [S1].'})+'\\n\\ndata: '+JSON.stringify({done:true,text:'A grounded WebKit explanation [S1].'})+'\\n\\n',{headers:{'Content-Type':'text/event-stream'}}) : originalFetch(url,opts);
  window.__notebookStage='create-note';
  document.querySelector('button[aria-label="New note"]').click();
  await wait(()=>document.querySelector('.nb-rich-editor'));
  const editor=document.querySelector('.nb-rich-editor'); editor.focus(); document.execCommand('insertText',false,'WebKit notebook thought');
  await wait(()=>editor.textContent.includes('WebKit notebook thought'));
  window.__notebookStage='insert-equation';
  document.querySelector('button[aria-label="Insert equation"]').click();
  await wait(()=>document.querySelector('input[aria-label="LaTeX equation"]'));
  const input=document.querySelector('input[aria-label="LaTeX equation"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'E=mc^2'); input.dispatchEvent(new Event('input',{bubbles:true}));
  input.form.requestSubmit(); await wait(()=>document.querySelector('.nb-rich-editor .katex'));
  window.__notebookStage='insert-image';
  const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);
  const data=canvas.toDataURL('image/png').split(',')[1], bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
  const transfer=new DataTransfer();transfer.items.add(new File([bytes],'WK image.png',{type:'image/png'}));
  const imageInput=document.querySelector('.nb-editor-shell input[type=file]');imageInput.files=transfer.files;imageInput.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(()=>document.querySelector('img[alt="WK image.png"]')?.naturalWidth===16);
  window.__notebookStage='inline-question';
  editor.editor.chain().insertContentAt(editor.editor.state.doc.content.size,{type:'paragraph'}).focus('end').run();
  document.querySelector('button[aria-label="Ask AI here"]').click();
  await wait(()=>document.querySelector('.nb-ai-question'));
  const field=document.querySelector('.nb-ai-question');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,\(question)[0]);field.dispatchEvent(new Event('input',{bubbles:true}));
  await wait(()=>[...document.querySelectorAll('.nb-ai-actions button')].some(b=>b.textContent==='Ask' && !b.disabled));
  [...document.querySelectorAll('.nb-ai-actions button')].find(b=>b.textContent==='Ask').click();
  window.__notebookStage='waiting-answer';
  await wait(()=>document.querySelector('.nb-inline-answer')?.textContent.includes('A grounded WebKit explanation'));
  window.__notebookStage='delete-question';
  document.querySelector('button[aria-label="Delete AI question"]').click();
  await wait(()=>!document.querySelector('.nb-ai-exchange'));
  if(!editor.textContent.includes('WebKit notebook thought') || !editor.querySelector('.katex') || !editor.querySelector('img')) throw new Error('Question deletion changed the surrounding note');
  document.querySelector('button[aria-label="Undo"]').click();
  await wait(()=>document.querySelector('.nb-inline-answer')?.textContent.includes('A grounded WebKit explanation'));
  document.querySelector('.nb-editor-footer button').click();
  await wait(()=>document.querySelector('.nb-entry-writing button[aria-label="Delete AI question"]'));
  document.querySelector('.nb-entry-writing button[aria-label="Delete AI question"]').click();
  await wait(()=>!document.querySelector('.nb-ai-exchange'));
  [...document.querySelectorAll('.nb-header-menu button')].find(b=>b.textContent.includes('Undo notebook action')).click();
  await wait(()=>document.querySelector('.nb-inline-answer')?.textContent.includes('A grounded WebKit explanation'));
  window.__notebookStage='waiting-save';
  await wait(()=>document.querySelector('.nb-save-state.is-saved'));
  window.__notebookStage='complete';
  window.__notebookCheck='complete';
})().catch(error=>{window.__notebookCheck='failed';window.webkit.messageHandlers.errors.postMessage(String(error));}); undefined;
""") { _, error in if let error = error { print("FAIL:", error); exit(1) } }
        return
      }
      if state["notebookCheck"] as? String != "complete" { return }
      if let signature = state["annotationUI"] as? String {
        if let expected = annotationUI, signature != expected { print("FAIL: annotation panel UI differs between formats"); exit(1) }
        annotationUI = signature
      }
      print("PASS:", meta["title"]!, "rendered after cold reload; rich notes, images, math, and inline AI verified")
      index += 1
      if index == fixtures.count { print("Desktop WebKit regression checks passed."); exit(0) }
      opened = false
      notebookCheckStarted = false
      view.reload()
    }
  }
}
app.run()
