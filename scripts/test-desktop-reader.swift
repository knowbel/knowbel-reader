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
configuration.setURLSchemeHandler(assets, forURLScheme: "tauri")
configuration.userContentController.add(errors, name: "errors")
configuration.userContentController.addUserScript(WKUserScript(source: """
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
let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
  if busy { return }
  ticks += 1
  if !errors.messages.isEmpty { exit(1) }
  if ticks > 240 { print("FAIL: desktop reader timed out at fixture", index); exit(1) }
  busy = true
  view.evaluateJavaScript("""
JSON.stringify({library: !!document.querySelector('.library-card-open'), empty: !!document.querySelector('.library-empty'),
  body: document.body?.innerText ?? '', core: !!window.pdfjsLib, native: !!document.querySelector('.native-reader'),
  canvas: [...document.querySelectorAll('.PdfHighlighter canvas')].some(c => c.width > 0 && c.height > 0 && c.getBoundingClientRect().width > 0),
  controls: !!document.querySelector('.page-nav')})
"""
  ) { value, error in
    defer { busy = false }
    if let error = error { print("FAIL:", error); exit(1) }
    guard let text = value as? String, let data = text.data(using: .utf8),
      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
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
    if opened && rendered && (state["body"] as? String ?? "").contains(fixture["expect"] as! String) {
      if native && state["core"] as? Bool == true { print("FAIL: Markdown loaded PDF.js"); exit(1) }
      print("PASS:", meta["title"]!, "rendered after cold reload")
      index += 1
      if index == fixtures.count { print("Desktop WebKit regression checks passed."); exit(0) }
      opened = false
      view.reload()
    }
  }
}
app.run()
